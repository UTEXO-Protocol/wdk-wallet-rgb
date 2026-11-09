// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { addonPath, assertTargetPin } from './bare-targets.mjs'

const [source, target = 'android-arm64', ...extra] = process.argv.slice(2)
if (!source || extra.length) throw new Error('Usage: stage-bare.mjs <built-addon> [target]')

const manifest = JSON.parse(await readFile(new URL('../src/onchain-bare-native.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const pin = Object.hasOwn(manifest.targets, target) ? manifest.targets[target] : undefined
if (!pin) throw new Error('No reviewed Bare artifact pin for ' + target)
assertTargetPin(target, pin, pkg.version)
const bytes = await readFile(source)
if (bytes.length !== pin.byteLength || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
  throw new Error('The built addon does not match the qualified native manifest')
}
const output = new URL('../' + addonPath(target), import.meta.url)
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, bytes, { mode: 0o644 })
await chmod(output, 0o644)
