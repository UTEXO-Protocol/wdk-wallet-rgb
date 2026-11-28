// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { addonPath, assertTargetPin } from './node-targets.mjs'

const [source, target, ...extra] = process.argv.slice(2)
if (!source || !target || extra.length) throw new Error('Usage: stage-node.mjs <built-addon> <target>')

const manifest = JSON.parse(await readFile(new URL('../src/onchain-node-native.json', import.meta.url), 'utf8'))
const pin = Object.hasOwn(manifest.targets, target) ? manifest.targets[target] : undefined
if (!pin) throw new Error('No reviewed Node artifact pin for ' + target)
assertTargetPin(target, pin)
const bytes = await readFile(source)
if (bytes.length !== pin.byteLength || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
  throw new Error('The built addon does not match the qualified native manifest')
}
const output = new URL('../' + addonPath(target), import.meta.url)
const directory = new URL('.', output)
await mkdir(directory, { recursive: true })
const temporary = new URL('.stage-' + randomUUID(), directory)
const file = await open(temporary, 'wx', 0o644)
try {
  try {
    await file.writeFile(bytes)
    await file.chmod(0o644)
  } finally {
    await file.close()
  }
  await rename(temporary, output)
} catch (error) {
  await unlink(temporary)
  throw error
}
