// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import manifest from '../../src/onchain-bare-native.json' with { type: 'json' }

const run = promisify(execFile)
let build
let buildDirectory
after(async () => { if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true }) })

async function compileFixture () {
  buildDirectory = await realpath(await mkdtemp(join(tmpdir(), 'wdk-node-api-fixture-build-')))
  const candidates = [process.env.NODE_INCLUDE_DIR, process.env.NODE_HEADERS_DIR,
    join(process.config.variables.node_prefix, 'include', 'node'),
    resolve(dirname(process.execPath), '..', 'include', 'node'),
    join(homedir(), 'Library', 'Caches', 'node-gyp', process.versions.node, 'include', 'node'),
    join(homedir(), '.cache', 'node-gyp', process.versions.node, 'include', 'node')].filter(Boolean)
  let headers
  for (const candidate of candidates) {
    try { await access(join(candidate, 'node_api.h')); headers = candidate; break } catch {}
  }
  if (!headers) throw new Error('Node-API fixture requires Node headers; set NODE_INCLUDE_DIR to their directory')
  const output = join(buildDirectory, 'fixture.node')
  const flags = process.platform === 'darwin' ? ['-dynamiclib', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC', '-ldl']
  await run(process.env.CC || 'cc', [...flags, '-std=c11', '-DNAPI_VERSION=8', '-I', headers,
    fileURLToPath(new URL('./node-addon-fixture.c', import.meta.url)), '-o', output])
  return output
}

// This is a real Node-API addon. Only this test fixture loads the sibling CJS
// handler; the production native engine has no JavaScript injection interface.
export async function buildFixtureAddon (t, handlerSource) {
  build ??= compileFixture()
  const base = await build
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wdk-node-api-fixture-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'fixture.node')
  await copyFile(base, path)
  await writeFile(path + '.fixture.cjs', handlerSource, { mode: 0o600 })
  const bytes = await readFile(path)
  return { path, directory, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }
}

// Import the real worker implementation against an isolated test admission
// manifest. There is no runtime override or special mode in the shipped SDK.
export async function importWorkerFixture (t, { addon, timeoutMs }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'wdk-node-worker-fixture-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = `${process.platform}-${process.arch}${process.platform === 'linux'
    ? (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl') : ''}`
  const fixtureManifest = { ...manifest, releaseHold: false, targets: { [target]: { sha256: addon.sha256, byteLength: addon.byteLength } } }
  const manifestUrl = 'data:application/json,' + encodeURIComponent(JSON.stringify(fixtureManifest))
  let source = await readFile(new URL('../../src/onchain-worker.js', import.meta.url), 'utf8')
  source = source.replaceAll("'./onchain-node-native.json'", JSON.stringify(manifestUrl))
    .replaceAll("'./onchain-runtime-error.js'", JSON.stringify(new URL('../../src/onchain-runtime-error.js', import.meta.url).href))
    .replaceAll("new URL('./onchain-node-thread.cjs', import.meta.url)", `new URL(${JSON.stringify(new URL('../../src/onchain-node-thread.cjs', import.meta.url).href)})`)
  if (timeoutMs !== undefined) source = source.replace('const REQUEST_TIMEOUT_MS = 120_000', `const REQUEST_TIMEOUT_MS = ${timeoutMs}`)
  const workerModuleUrl = pathToFileURL(join(directory, 'onchain-worker.mjs')).href
  await writeFile(fileURLToPath(workerModuleUrl), source, { mode: 0o600 })
  const imported = await import(workerModuleUrl)
  return { ...imported, workerModuleUrl, fixtureManifest }
}
