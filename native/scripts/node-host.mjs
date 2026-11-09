// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '../..')
const native = join(root, 'native')
const toolchain = '+1.94.0'
const binaryName = 'utexo-rgb-native'
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

async function executableAbi (path, target) {
  const header = Buffer.alloc(32)
  const file = await open(path, 'r')
  try {
    assert.equal((await file.read(header, 0, header.length, 0)).bytesRead, header.length, 'Truncated native executable')
  } finally {
    await file.close()
  }
  if (target.startsWith('darwin-')) {
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected a 64-bit thin Mach-O')
    assert.equal(header.readUInt32LE(4), target === 'darwin-arm64' ? 0x0100000c : 0x01000007, 'Wrong Mach-O CPU')
    assert.equal(header.readUInt32LE(12), 2, 'Expected a Mach-O executable')
    const buildVersion = /\bminos\s+(\S+)/.exec(command('otool', ['-l', path]))
    const needed = command('otool', ['-L', path]).split('\n').slice(1).map(line => line.trim().split(' (compatibility version ')[0])
    return { format: 'Mach-O', minimumOS: buildVersion?.[1] ?? null, needed }
  }
  assert.equal(header.subarray(0, 6).toString('hex'), '7f454c460201', 'Expected a 64-bit little-endian ELF')
  assert.equal(header.readUInt16LE(18), target === 'linux-arm64-gnu' ? 183 : 62, 'Wrong ELF machine')
  assert.ok([2, 3].includes(header.readUInt16LE(16)), 'Expected an ELF executable or PIE')
  // Inspect the file directly. ldd on an untrusted ELF can execute its loader.
  const details = command('readelf', ['--wide', '--program-headers', '--dynamic', '--version-info', path])
  const interpreter = /Requesting program interpreter: ([^\]]+)/.exec(details)?.[1] ?? null
  const needed = Array.from(details.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g), match => match[1])
  const glibcVersions = [...new Set(Array.from(details.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g), match => match[1]))].sort()
  if (target.endsWith('-musl')) {
    assert.ok(interpreter === null || /\/ld-musl-x86_64\.so\.1$/.test(interpreter), 'Unexpected musl ELF interpreter')
    assert.equal(glibcVersions.length, 0, 'Unexpected glibc symbol in musl executable')
  } else {
    const loader = target === 'linux-arm64-gnu' ? '/ld-linux-aarch64.so.1' : '/ld-linux-x86-64.so.2'
    assert.ok(interpreter?.endsWith(loader), 'Unexpected glibc ELF interpreter')
  }
  return { format: 'ELF', interpreter, needed, glibcVersions }
}

async function verify (target, executable, expectedSha256, runtime = verifyHost(target)) {
  assert.match(expectedSha256, /^[0-9a-f]{64}$/, 'Supply the independently recorded native SHA-256')
  const path = resolve(executable)
  const stat = await lstat(path)
  assert.ok(stat.isFile() && await realpath(path) === path && (stat.mode & 0o022) === 0, 'Expected a canonical protected executable')
  assert.equal(await sha256(path), expectedSha256, 'Native executable SHA-256 differs')
  const abi = await executableAbi(path, target)

  const { OnchainWorker } = await import('../../src/onchain-worker.js')
  const { WalletManagerRgb } = await import('../../onchain.js')
  await assert.rejects(OnchainWorker.start(path, '0'.repeat(64)), { code: 'NATIVE_IDENTITY_MISMATCH' })
  const worker = await OnchainWorker.start(path, expectedSha256)
  let nativeIdentity
  try {
    nativeIdentity = await worker.request('version')
  } finally {
    await worker.close()
  }
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'wdk-node-wallet-'))
  const seed = randomBytes(64)
  const config = {
    nativeExecutable: path,
    nativeSha256: expectedSha256,
    dataDir: join(directory, 'wallet'),
    network: 'regtest',
    startupMode: 'offline',
    indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
    maxFeeSats: '5000',
    authorize: () => { throw new Error('Offline host smoke cannot authorize a transaction') }
  }
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
  try {
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
    verified: ['binary hash and ABI', 'mismatched hash rejected', 'native protocol negotiation', 'offline Regtest open, reads, shutdown and reopen']
  }
}

function sourceIdentity () {
  const paths = ['native/Cargo.lock', 'native/Cargo.toml', 'native/src', 'native/patches', 'native/scripts/prepare-source.py', 'onchain.js', 'src', 'package.json', 'package-lock.json']
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=normal', '--', ...paths]), '', 'Build and smoke require committed source inputs')
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
  const args = [toolchain, 'build', '--release', '--locked', '--bin', binaryName, '--message-format=json-render-diagnostics']
  if (runtime.platform === 'linux') args.push('--target', runtime.rustTarget)
  const result = spawnSync('cargo', args, {
    cwd: native,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...(runtime.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '11.0' } : {}) }
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Locked native worker build failed')
  const artifacts = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const worker = artifacts.filter(item => item.reason === 'compiler-artifact' &&
    item.target.name === binaryName && item.target.kind.includes('bin') && item.executable)
  assert.equal(worker.length, 1, 'Expected exactly one Cargo worker executable')
  command('python3', prepare, native)
  assert.deepEqual(sourceIdentity(), source, 'Committed inputs changed during the build')

  const output = resolve(destination)
  await mkdir(output, { mode: 0o700 })
  try {
    const path = join(await realpath(output), binaryName)
    await copyFile(worker[0].executable, path)
    await chmod(path, 0o755)
    const checked = await verify(target, path, await sha256(path), runtime)
    const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
    const receipt = {
      ...checked,
      packageVersion,
      source,
      rustc,
      cargo: command('cargo', [toolchain, '--version'], native),
      cargoLockSha256: await sha256(join(native, 'Cargo.lock')),
      buildScriptSha256: await sha256(script)
    }
    await writeFile(join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    return receipt
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

async function main () {
  const [mode, target, input, pin] = process.argv.slice(2)
  if (!Object.hasOwn(targets, target) || !input || process.argv.length > 6 ||
    (mode !== 'build' && mode !== 'verify') || (mode === 'verify' && !pin)) {
    throw new Error('Usage: node native/scripts/node-host.mjs build <target> <new-output-directory> [rgb-source-dir]\n' +
      '       node native/scripts/node-host.mjs verify <target> <executable> <sha256>\n' +
      'Targets: ' + Object.keys(targets).join(', '))
  }
  const result = mode === 'build' ? await build(target, input, pin) : await verify(target, input, pin)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
