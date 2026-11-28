// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../..')
const native = join(root, 'native')
const toolchain = '+1.94.0'
const binaryName = 'utexo-rgb-native.node'
const targets = {
  'darwin-arm64': ['darwin', 'arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['darwin', 'x64', 'x86_64-apple-darwin'],
  'linux-x64-gnu': ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
  'linux-x64-musl': ['linux', 'x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64-gnu': ['linux', 'arm64', 'aarch64-unknown-linux-gnu']
}

function command (program, args, cwd = root) {
  return execFileSync(program, args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
}

async function sha256 (path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function verifyHost (target) {
  const [platform, arch, rustTarget] = targets[target]
  assert.equal(process.platform, platform, 'Run qualification on the selected operating system')
  assert.equal(process.arch, arch, 'Run qualification with a Node executable for the selected architecture')
  const runtime = { platform, arch, rustTarget, node: process.version }
  if (platform === 'darwin') {
    const translated = spawnSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' })
    runtime.rosetta = translated.stdout?.trim() === '1'
  } else {
    const glibc = process.report.getReport().header.glibcVersionRuntime
    if (target.endsWith('-musl')) {
      const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8' })
      const musl = /musl libc[^\n]*\nVersion (\S+)/i.exec(ldd.stdout + ldd.stderr)
      assert.ok(!glibc && musl, 'Run the musl qualification in a musl Node userland')
      runtime.libc = { name: 'musl', version: musl[1] }
    } else {
      assert.ok(glibc, 'Run the GNU qualification in a glibc Node userland')
      runtime.libc = { name: 'glibc', version: glibc }
    }
  }
  return runtime
}

async function addonAbi (path, target) {
  const header = Buffer.alloc(32)
  const file = await open(path, 'r')
  try {
    assert.equal((await file.read(header, 0, header.length, 0)).bytesRead, header.length, 'Truncated native addon')
  } finally {
    await file.close()
  }
  if (target.startsWith('darwin-')) {
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected a 64-bit thin Mach-O')
    assert.equal(header.readUInt32LE(4), target === 'darwin-arm64' ? 0x0100000c : 0x01000007, 'Wrong Mach-O CPU')
    assert.equal(header.readUInt32LE(12), 6, 'Expected a Mach-O dynamic library')
    const buildVersion = /\bminos\s+(\S+)/.exec(command('otool', ['-l', path]))
    const needed = command('otool', ['-L', path]).split('\n').slice(1).map(line => line.trim().split(' (compatibility version ')[0])
    return { format: 'Mach-O', minimumOS: buildVersion?.[1] ?? null, needed }
  }
  assert.equal(header.subarray(0, 6).toString('hex'), '7f454c460201', 'Expected a 64-bit little-endian ELF')
  assert.equal(header.readUInt16LE(18), target === 'linux-arm64-gnu' ? 183 : 62, 'Wrong ELF machine')
  assert.equal(header.readUInt16LE(16), 3, 'Expected an ELF shared library')
  // Inspect the file directly. ldd on an untrusted ELF can execute its loader.
  const details = command('readelf', ['--wide', '--program-headers', '--dynamic', '--version-info', path])
  const interpreter = /Requesting program interpreter: ([^\]]+)/.exec(details)?.[1] ?? null
  const needed = Array.from(details.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g), match => match[1])
  const glibcVersions = [...new Set(Array.from(details.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g), match => match[1]))].sort()
  assert.equal(interpreter, null, 'Node addons must not have an ELF interpreter')
  assert.match(details, /\(GNU_RELRO\)|GNU_RELRO/, 'Missing RELRO segment')
  assert.match(details, /BIND_NOW|\bNOW\b/, 'Missing immediate binding')
  assert.match(details, /NODELETE/, 'Missing process lifetime protection')
  if (target.endsWith('-musl')) {
    assert.equal(glibcVersions.length, 0, 'Unexpected glibc symbol in musl addon')
  }

  return { format: 'ELF', interpreter, needed, glibcVersions }
}

export async function stageQualificationPackage (sourceRoot, directory, qualification) {
  const staged = join(directory, 'package')
  const manifestPath = join(sourceRoot, 'src/onchain-bare-native.json')
  const original = await readFile(manifestPath)
  const manifest = JSON.parse(original)
  await mkdir(staged, { mode: 0o700 })
  await copyFile(join(sourceRoot, 'onchain.js'), join(staged, 'onchain.js'))
  await copyFile(join(sourceRoot, 'package.json'), join(staged, 'package.json'))
  await cp(join(sourceRoot, 'src'), join(staged, 'src'), { recursive: true })
  await symlink(await realpath(join(sourceRoot, 'node_modules')), join(staged, 'node_modules'), 'dir')
  // Qualification can run before artifact admission. Change only this private
  // copy: source pins, publication hold and every runtime check stay intact.
  manifest.releaseHold = false
  await writeFile(join(staged, 'src/onchain-bare-native.json'), JSON.stringify(manifest, null, 2) + '\n')
  const nodePath = join(sourceRoot, 'src/onchain-node-native.json')
  const originalNode = await readFile(nodePath)
  const node = JSON.parse(originalNode)
  if (qualification) {
    assert.ok(Object.hasOwn(targets, qualification.target))
    const { assertTargetPin } = await import('../../scripts/node-targets.mjs')
    assertTargetPin(qualification.target, qualification.pin)
    node.targets = { [qualification.target]: qualification.pin }
    node.releaseHold = false
    await writeFile(join(staged, 'src/onchain-node-native.json'), JSON.stringify(node, null, 2) + '\n')
  }
  assert.deepEqual(await readFile(nodePath), originalNode, 'Node source admission changed')
  assert.deepEqual(await readFile(manifestPath), original, 'Source manifest changed during qualification staging')
  return staged
}

async function verify (target, addon, expectedSha256, runtime = verifyHost(target)) {
  assert.match(expectedSha256, /^[0-9a-f]{64}$/, 'Supply the independently recorded native SHA-256')
  const path = resolve(addon)
  const stat = await lstat(path)
  assert.ok(stat.isFile() && await realpath(path) === path && (stat.mode & 0o022) === 0, 'Expected a canonical protected addon')
  assert.equal(await sha256(path), expectedSha256, 'Native addon SHA-256 differs')
  const abi = await addonAbi(path, target)

  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'wdk-node-wallet-'))
  const seed = randomBytes(64)
  const config = {
    nativeAddon: path,
    nativeSha256: expectedSha256,
    dataDir: join(directory, 'wallet'),
    network: 'regtest',
    startupMode: 'offline',
    indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
    maxFeeSats: '5000',
    authorize: () => { throw new Error('Offline host smoke cannot authorize a transaction') }
  }
  let nativeIdentity
  try {
    const staged = await stageQualificationPackage(root, directory, { target, pin: { sha256: expectedSha256, byteLength: stat.size } })
    const { OnchainWorker } = await import(pathToFileURL(join(staged, 'src/onchain-worker.js')).href)
    await assert.rejects(OnchainWorker.start(path, '0'.repeat(64)), { code: 'NATIVE_IDENTITY_MISMATCH' })
    const worker = await OnchainWorker.start(path, expectedSha256)
    try { nativeIdentity = await worker.request('version') } finally { await worker.close() }
    assert.equal(nativeIdentity.runtime, 'node-in-process')
    const { WalletManagerRgb } = await import(pathToFileURL(join(staged, 'onchain.js')).href)
    async function openWallet () {
      const manager = new WalletManagerRgb(seed, config)
      try {
        const account = await manager.getAccount()
        assert.equal(account.getConnectionStatus(), 'offline')
        assert.equal(await account.getBalance(), 0n)
        assert.deepEqual(await account.listAssets(), [])
        assert.deepEqual(await account.getTransactions(), [])
        const address = await account.getMessageSigningAddress()
        assert.match(address, /^bcrt1p/)
        return address
      } finally {
        await manager.shutdown()
      }
    }
    const address = await openWallet()
    assert.equal(await openWallet(), address, 'Reopened wallet identity differs')
  } finally {
    seed.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
  return {
    target,
    runtime,
    abi,
    nativeIdentity,
    binary: { name: binaryName, sha256: expectedSha256, size: stat.size },
    verified: ['addon hash and ABI', 'mismatched hash rejected', 'native protocol negotiation', 'offline Regtest open, reads, shutdown and reopen']
  }
}

function sourceIdentity () {
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=normal']), '', 'Build and smoke require a clean committed checkout')
  return {
    commit: command('git', ['rev-parse', 'HEAD']),
    tree: command('git', ['rev-parse', 'HEAD^{tree}'])
  }
}

async function build (target, destination, sourceDirectory) {
  const runtime = verifyHost(target)
  const source = sourceIdentity()
  const rustc = command('rustc', [toolchain, '-vV'], native)
  assert.ok(rustc.split('\n').includes('host: ' + runtime.rustTarget), 'Install Rust 1.94.0 for the selected native target')
  const prepare = ['scripts/prepare-source.py', '--bare']
  if (sourceDirectory) prepare.push(await realpath(sourceDirectory))
  command('python3', prepare, native)
  const buildDirectory = await mkdtemp(join(await realpath(tmpdir()), 'wdk-node-build-'))
  const built = join(buildDirectory, binaryName)
  try {
    execFileSync('bash', [join(native, 'node/build.sh'), target, built], {
      cwd: root, stdio: 'inherit', env: process.env
    })
    command('python3', prepare, native)
    assert.deepEqual(sourceIdentity(), source, 'Committed inputs changed during the build')

    const output = resolve(destination)
    await mkdir(output, { mode: 0o700 })
    try {
      const path = join(await realpath(output), binaryName)
      await copyFile(built, path)
      await chmod(path, 0o644)
      const checked = await verify(target, path, await sha256(path), runtime)
      execFileSync(process.execPath, [join(native, 'node/smoke.cjs'), path], { cwd: root, stdio: 'inherit' })
      assert.deepEqual(sourceIdentity(), source, 'Committed inputs changed during qualification')
      const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
      const receipt = {
        ...checked,
        packageVersion,
        source,
        rustc,
        cargo: command('cargo', [toolchain, '--version'], native),
        cargoLockSha256: await sha256(join(native, 'Cargo.lock')),
        buildScriptSha256: await sha256(script),
        nodeApiVersion: 8,
        addonInputDigests: Object.fromEntries(await Promise.all(
          ['native/node/build.sh', 'native/node/binding.c', 'native/node/lib.rs', 'native/Cargo.toml', 'native/Cargo.lock']
            .map(async name => [name, await sha256(join(root, name))])))
      }
      await writeFile(join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      return receipt
    } catch (error) {
      await rm(output, { recursive: true, force: true })
      throw error
    }
  } finally {
    await rm(buildDirectory, { recursive: true, force: true })
  }
}

async function main () {
  const [mode, target, input, pin] = process.argv.slice(2)
  if (!Object.hasOwn(targets, target) || !input || process.argv.length > 6 ||
    (mode !== 'build' && mode !== 'verify') || (mode === 'verify' && !pin)) {
    throw new Error('Usage: node native/scripts/node-host.mjs build <target> <new-output-directory> [rgb-source-dir]\n' +
      '       node native/scripts/node-host.mjs verify <target> <addon.node> <sha256>\n' +
      'Targets: ' + Object.keys(targets).join(', '))
  }
  const result = mode === 'build' ? await build(target, input, pin) : await verify(target, input, pin)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
