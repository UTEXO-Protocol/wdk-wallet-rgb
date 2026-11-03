// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { keccak_256 as keccak256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { base58check, base64 } from '@scure/base'

export const MAX_BURN_PROOF_BYTES = 10 * 1024 * 1024
const TYPE = 'UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)'
const FIELDS = ['version', 'destinationChainId', 'dstEid', 'recipient']
const tronBase58 = base58check(sha256)

/** Return chain-native address bytes. Tron must be a checksummed native address;
 * never silently reinterpret an EVM address as an account on another chain. */
function payoutRecipient (chainId, address) {
  if (typeof address !== 'string') throw new TypeError('Invalid payout address')
  if (chainId.startsWith('eip155:')) {
    if (!/^0x[a-f\d]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) {
      throw new TypeError('A nonzero EVM payout address is required')
    }
    const body = address.slice(2)
    if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
      const hash = bytesToHex(keccak256(utf8ToBytes(body.toLowerCase())))
      if ([...body].some((letter, index) => /[a-f]/i.test(letter) &&
        (Number.parseInt(hash[index], 16) >= 8 ? letter !== letter.toUpperCase() : letter !== letter.toLowerCase()))) {
        throw new TypeError('Invalid EVM payout address checksum')
      }
    }
    return address.toLowerCase()
  }
  if (!address.startsWith('T') || address.length !== 34) throw new TypeError('A native Tron payout address is required')
  let payload
  try { payload = tronBase58.decode(address) } catch { throw new TypeError('Invalid Tron payout address checksum') }
  if (payload.length !== 21 || payload[0] !== 0x41 || payload.slice(1).every(byte => byte === 0) ||
      tronBase58.encode(payload) !== address) throw new TypeError('Invalid Tron payout address')
  return '0x' + bytesToHex(payload)
}

/** Validate the portable V1 preimage; route policy is checked separately. */
export function validateBurnDestination (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== FIELDS.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !FIELDS.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
      value.version !== 1 || !Number.isSafeInteger(value.destinationChainId) || value.destinationChainId <= 0 ||
      !Number.isSafeInteger(value.dstEid) || value.dstEid < 0 || value.dstEid > 0xffffffff ||
      typeof value.recipient !== 'string' || !/^0x(?:[a-f\d]{2}){1,32}$/i.test(value.recipient) ||
      (value.dstEid === 0 && value.recipient.length !== 42)) {
    throw new TypeError('Invalid V1 burn destination')
  }
  return Object.freeze({
    version: 1,
    destinationChainId: value.destinationChainId,
    dstEid: value.dstEid,
    recipient: value.recipient.toLowerCase()
  })
}

/** HashStruct, not an EIP-712 domain/signature digest. Native accepts this hex without 0x. */
export function burnDestinationHash (value) {
  const destination = validateBurnDestination(value)
  const encoded = new Uint8Array(128)
  encoded.set(keccak256(utf8ToBytes(TYPE)))
  const view = new DataView(encoded.buffer)
  view.setBigUint64(56, BigInt(destination.destinationChainId))
  view.setUint32(92, destination.dstEid)
  encoded.set(keccak256(hexToBytes(destination.recipient.slice(2))), 96)
  return bytesToHex(keccak256(encoded))
}

/** Construct an explicitly admitted EVM or Tron route. Never infer an endpoint ID.
 * This encodes a commitment; it does not establish payout liquidity or settlement. */
export function burnDestinationFor (payout, routes) {
  if (!payout || typeof payout.chainId !== 'string' ||
      !/^(?:eip155|tron):[1-9]\d{0,15}$/.test(payout.chainId) || !Array.isArray(routes)) {
    throw new TypeError('A supported payout chain and native address are required')
  }
  const matches = routes.filter(route => route?.chainId === payout.chainId)
  if (matches.length !== 1) throw new TypeError('This V1 payout route is not qualified')
  const recipient = payoutRecipient(payout.chainId, payout.address)
  if (payout.chainId.startsWith('tron:') && matches[0].dstEid === 0) {
    throw new TypeError('A Tron payout requires an explicit nonzero endpoint')
  }
  return validateBurnDestination({
    version: 1,
    destinationChainId: Number(payout.chainId.split(':')[1]),
    dstEid: matches[0].dstEid,
    recipient
  })
}

/** A portable export of an already saved proof. Never invokes a wallet or burns. */
export function createBurnPackage (proof, value) {
  const magic = [82, 71, 66, 0, 84, 70, 82]
  if (!(proof instanceof Uint8Array) || proof.length > MAX_BURN_PROOF_BYTES) {
    throw new TypeError('Expected a saved RGB Transfer proof of at most 10 MiB')
  }
  const bytes = proof.slice()
  if (bytes.length <= magic.length || !magic.every((byte, index) => bytes[index] === byte)) {
    throw new TypeError('Expected a saved RGB Transfer proof of at most 10 MiB')
  }
  const destination = validateBurnDestination(value)
  return JSON.stringify({
    format: 'utexo-burn',
    version: 1,
    consignment: { encoding: 'base64', byteLength: bytes.length, data: base64.encode(bytes) },
    burnDestination: destination
  })
}
