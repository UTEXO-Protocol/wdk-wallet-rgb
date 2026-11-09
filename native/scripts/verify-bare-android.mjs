// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const [addonArg, runtimeArg, version, bareTarget = 'android-arm64'] = args
if (!addonArg || !runtimeArg || !version || args.length > 4) {
  throw new Error('Usage: verify-bare-android.mjs ADDON BARE_KIT_RUNTIME CANDIDATE_VERSION [BARE_TARGET]')
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(version)) {
  throw new Error('Expected an exact candidate package version')
}
const targets = new Map([
  ['android-arm64', { abi: 'arm64-v8a', triple: 'aarch64-linux-android', sysroot: 'aarch64-linux-android', format: 'elf64-littleaarch64' }],
  ['android-arm', { abi: 'armeabi-v7a', triple: 'armv7-linux-androideabi', sysroot: 'arm-linux-androideabi', format: 'elf32-littlearm' }],
  ['android-x64', { abi: 'x86_64', triple: 'x86_64-linux-android', sysroot: 'x86_64-linux-android', format: 'elf64-x86-64' }],
  ['android-ia32', { abi: 'x86', triple: 'i686-linux-android', sysroot: 'i686-linux-android', format: 'elf32-i386' }]
])
const platform = targets.get(bareTarget)
if (!platform) throw new Error(`Unsupported Bare Android target: ${bareTarget}`)
const ndkHost = { darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[process.platform]
if (!ndkHost) throw new Error('Use a macOS or Linux Android NDK host')
const root = fileURLToPath(new URL('../', import.meta.url))
const defaultSdk = join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || defaultSdk
const ndk = join(sdk, 'ndk/28.2.13676358/toolchains/llvm/prebuilt', ndkHost)
const readobj = join(ndk, 'bin/llvm-readobj')
const addon = realpathSync(addonArg)
const runtime = realpathSync(runtimeArg)
const system = resolve(ndk, 'sysroot/usr/lib', platform.sysroot, '26')
const libraries = ['libc.so', 'libdl.so', 'liblog.so', 'libm.so']
const exportsExpected = ['bare_get_module_name_v0', 'bare_register_module_v0']
const soname = `libutexo__wdk-wallet-rgb.${version}.so`
const expectedCargoLock = 'f3d59ddc4bc5b0b225cbed3ded41069682303d6a888041825e08c6d3a96f4d0c'
const expectedIntegrationTree = '8a012db8c770db8c10be554dcdd34c95b16f81a8'
const page = 16 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ensure = (condition, message) => {
  if (!condition) throw new Error(message)
}

function readElf (file) {
  const [elf] = JSON.parse(execFileSync(readobj, [
    '--elf-output-style=JSON', '--file-header', '--program-headers', '--sections', '--needed-libs', '--dyn-symbols', file
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
  return elf
}

function segments (elf, type) {
  return elf.ProgramHeaders.map(item => item.ProgramHeader).filter(header => header.Type.Name === type)
}

function dynamicFlags (bytes, elf) {
  const [dynamic, extra] = segments(elf, 'PT_DYNAMIC')
  const wordBytes = platform.format.startsWith('elf64-') ? 8 : 4
  const entryBytes = 2 * wordBytes
  const readWord = wordBytes === 8
    ? offset => bytes.readBigUInt64LE(offset)
    : offset => BigInt(bytes.readUInt32LE(offset))
  ensure(dynamic && !extra && dynamic.Offset >= 0 && dynamic.FileSize > 0 &&
    dynamic.FileSize <= 1024 * 1024 && dynamic.FileSize % entryBytes === 0 &&
    dynamic.Offset + dynamic.FileSize <= bytes.length, 'Invalid dynamic segment')
  const tags = new Map()
  for (let i = dynamic.Offset; i < dynamic.Offset + dynamic.FileSize; i += entryBytes) {
    const tag = readWord(i)
    if (tag === 0n) return tags
    if (tag !== 1n) ensure(!tags.has(tag), 'Duplicate dynamic tag')
    tags.set(tag, readWord(i + wordBytes))
  }
  throw new Error('Dynamic segment lacks a terminator')
}

function exportsOf (elf) {
  return new Set(elf.DynamicSymbols.map(item => item.Symbol)
    .filter(symbol => symbol.Name.Name && symbol.Section.Name !== 'Undefined' &&
      ['Global', 'Weak'].includes(symbol.Binding.Name) && [0, 3].includes(symbol.Other.Value & 3))
    .map(symbol => symbol.Name.Name.replace('@@', '@')))
}

const bytes = readFileSync(addon)
const devPolicy = readFileSync(join(root, '../src/onchain-dev-services.json'))
ensure(bytes.includes(Buffer.from(`utexo__wdk-wallet-rgb@${version}\0`)), 'Unexpected Bare registration identity')
ensure(bytes.includes(Buffer.from(expectedIntegrationTree)), 'The addon does not contain the expected native tree identity')
ensure(bytes.includes(devPolicy), 'The addon does not contain the exact Dev Signet service policy')
const elf = readElf(addon)
ensure(elf.FileSummary.Format === platform.format && elf.ElfHeader.Type === 'SharedObject (0x3)' &&
  elf.FileSummary.LoadName === soname, `Unexpected ${bareTarget} addon format or SONAME`)
const loads = segments(elf, 'PT_LOAD')
ensure(loads.length > 0 && loads.every(load => load.Alignment >= page && load.Alignment % page === 0 &&
  (load.VirtualAddress - load.Offset) % page === 0 && (load.Flags.Value & 3) !== 3), 'Unaligned or writable executable LOAD')
const [stack, extraStack] = segments(elf, 'PT_GNU_STACK')
ensure(stack && !extraStack && (stack.Flags.Value & 1) === 0, 'Executable or missing GNU_STACK')
const [relro, extraRelro] = segments(elf, 'PT_GNU_RELRO')
ensure(relro && !extraRelro && relro.MemSize > 0 &&
  (relro.VirtualAddress + relro.MemSize) % page === 0, 'Unaligned or missing GNU_RELRO')
const [dynamic] = segments(elf, 'PT_DYNAMIC')
const protectedSections = elf.Sections.map(item => item.Section)
  .filter(section => ['.dynamic', '.got', '.got.plt'].includes(section.Name.Name))
ensure(protectedSections.some(section => section.Name.Name === '.got') && protectedSections.every(section =>
  section.Address >= relro.VirtualAddress && section.Address + section.Size <= relro.VirtualAddress + relro.MemSize
) && dynamic && dynamic.VirtualAddress >= relro.VirtualAddress &&
  dynamic.VirtualAddress + dynamic.MemSize <= relro.VirtualAddress + relro.MemSize, 'Dynamic table or GOT outside RELRO')

const flags = dynamicFlags(bytes, elf)
ensure(((flags.get(0x6ffffffbn) ?? 0n) & 9n) === 9n, 'Immediate binding and NODELETE are required')
ensure(!flags.has(15n) && !flags.has(29n) && !flags.has(22n) && ((flags.get(30n) ?? 0n) & 4n) === 0n, 'Unsafe text relocations or search path')
ensure(JSON.stringify([...elf.NeededLibraries].sort()) === JSON.stringify(libraries), 'Unexpected native dependencies')
ensure(JSON.stringify([...exportsOf(elf)].sort()) === JSON.stringify(exportsExpected), 'Unexpected native exports')

const runtimeElf = readElf(runtime)
const runtimeBytes = readFileSync(runtime)
ensure(runtimeElf.FileSummary.Format === platform.format && runtimeElf.ElfHeader.Type === 'SharedObject (0x3)' &&
  ((dynamicFlags(runtimeBytes, runtimeElf).get(0x6ffffffbn) ?? 0n) & 2n) === 2n,
`Expected global-loader-group ${bareTarget} BareKit`)
const systemExports = new Set(libraries.flatMap(library => [...exportsOf(readElf(join(system, library)))]))
const runtimeExports = exportsOf(runtimeElf)
const imports = elf.DynamicSymbols.map(item => item.Symbol)
  .filter(symbol => symbol.Name.Name && symbol.Section.Name === 'Undefined')
const bareImports = []
for (const symbol of imports) {
  const name = symbol.Name.Name
  if (name.startsWith('js_')) {
    ensure(runtimeExports.has(name), `BareKit does not export ${name}`)
    bareImports.push(name)
  } else if (symbol.Binding.Name === 'Global') {
    ensure(systemExports.has(name), `Android API 26 cannot resolve ${name}`)
  }
}

const lock = readFileSync(join(root, 'bare/Cargo.lock'))
ensure(hash(lock) === expectedCargoLock, 'The previously qualified Cargo lock changed')
console.log(JSON.stringify({
  target: platform.triple,
  abi: platform.abi,
  minNativeApi: 26,
  androidNdk: '28.2.13676358',
  rust: '1.94.0',
  soname,
  candidateVersion: version,
  addon: { path: addon, sha256: hash(bytes), byteLength: bytes.length },
  runtime: { path: runtime, sha256: hash(runtimeBytes) },
  cargoLockSha256: hash(lock),
  bindingSourceSha256: hash(readFileSync(join(root, 'bare/binding.c'))),
  nativeEngineSha256: hash(readFileSync(join(root, 'src/engine.rs'))),
  devPolicySha256: hash(devPolicy),
  devHostedEnabled: JSON.parse(devPolicy).enabled === true,
  rgb: {
    revision: '9ec49c08be2e68f08521281e3efbd760ec989cb9',
    integrationTree: expectedIntegrationTree,
    features: ['electrum', 'esplora', 'camel_case']
  },
  loadAlignments: loads.map(load => load.Alignment),
  relro: { sections: protectedSections.map(section => section.Name.Name), aligned: true },
  bindNow: true,
  nodelete: true,
  nxStack: true,
  neededLibraries: libraries,
  bareExports: exportsExpected,
  bareImports: bareImports.sort()
}, null, 2))
