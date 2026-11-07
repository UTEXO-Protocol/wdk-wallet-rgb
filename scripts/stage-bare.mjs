// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

const [source] = process.argv.slice(2)
if (!source) throw new Error('Pass the canonical Bare addon build path')

const manifest = JSON.parse(await readFile(new URL('../src/onchain-bare-native.json', import.meta.url), 'utf8'))
const bytes = await readFile(source)
if (bytes.length !== manifest.byteLength || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
  throw new Error('The built addon does not match the qualified native manifest')
}
if (!['android-arm64', 'darwin-arm64'].includes(manifest.target)) throw new Error('Unexpected Bare addon target')
const directory = new URL('../prebuilds/' + manifest.target + '/', import.meta.url)
await mkdir(directory, { recursive: true })
const target = new URL('utexo__wdk-wallet-rgb.bare', directory)
await writeFile(target, bytes, { mode: 0o644 })
await chmod(target, 0o644)
