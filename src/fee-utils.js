'use strict'

/**
 * Estimate transaction virtual size (vbytes) from a signed PSBT.
 *
 * Parses the raw PSBT binary to count inputs and outputs from the
 * embedded unsigned transaction, then estimates vbytes assuming
 * P2TR key-path spending (most common case for RGB wallets).
 *
 * Why not use `signedPsbt.length * 0.4`?
 * PSBT is a container format with metadata (derivation paths, witness
 * UTXO, sig hashes, etc.) that is NOT present in the final transaction.
 * The naive size-to-vbytes coefficient severely underestimates the real
 * fee, causing transactions to get stuck in the mempool.
 *
 * @param {string} psbtBase64 - Base64-encoded PSBT
 * @returns {number} Estimated virtual size in bytes
 */
export function estimateVbytesFromPsbt (psbtBase64) {
  const raw = Uint8Array.from(atob(psbtBase64), c => c.charCodeAt(0))

  // PSBT magic: 0x70736274 0xFF 0x00
  if (raw[0] === 0x70 && raw[1] === 0x73 && raw[2] === 0x62 && raw[3] === 0x74) {
    return estimateVbytesFromPsbtBinary(raw)
  }

  // Fallback: assume single-input, two-output P2TR transaction (~153 vbytes)
  return 153
}

/**
 * Parse PSBT binary to extract input/output count and estimate vbytes.
 * @param {Uint8Array} raw
 */
function estimateVbytesFromPsbtBinary (raw) {
  let offset = 5 // skip magic (4 bytes) + separator (0xFF)

  // Skip global proprietary fields until we reach the unsigned tx
  while (offset < raw.length) {
    const keyType = raw[offset]
    if (keyType === 0x00) { offset++; break } // separator
    offset++ // key type byte

    // Read key length (compact-size) and skip the key data
    const keyLen = readCompactSize(raw, offset)
    offset = keyLen.nextOffset
    offset += keyLen.value // skip key data

    // Read value length and skip value data
    const valLen = readCompactSize(raw, offset)
    offset = valLen.nextOffset
    offset += valLen.value
  }

  // Now we're in the global tx section
  offset += 4 // skip version (4 bytes)

  // Read input count
  const inputCount = readCompactSize(raw, offset)
  offset = inputCount.nextOffset

  // Skip each input (32 bytes txid + 4 bytes vout + 4 bytes sequence = 40 bytes each)
  offset += inputCount.value * 40

  // Read output count
  const outputCount = readCompactSize(raw, offset)

  const numInputs = inputCount.value
  const numOutputs = outputCount.value

  // P2TR key-path vbyte estimation
  // Base: 10.5 vbytes overhead
  // Per input: 57.5 vbytes (10.5 non-witness + 47 witness discounted at 1/4)
  // Per output: 43 vbytes
  const TX_OVERHEAD_VBYTES = 11
  const P2TR_INPUT_VBYTES = 58
  const P2TR_OUTPUT_VBYTES = 43

  return TX_OVERHEAD_VBYTES + numInputs * P2TR_INPUT_VBYTES + numOutputs * P2TR_OUTPUT_VBYTES
}

/**
 * Read a Bitcoin compact-size (varint) from a buffer.
 * @param {Uint8Array} buf
 * @param {number} pos
 * @returns {{ value: number, nextOffset: number }}
 */
function readCompactSize (buf, pos) {
  const first = buf[pos]
  if (first < 0xfd) return { value: first, nextOffset: pos + 1 }
  if (first === 0xfd) return { value: buf[pos + 1] | (buf[pos + 2] << 8), nextOffset: pos + 3 }
  if (first === 0xfe) {
    return {
      value: buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24),
      nextOffset: pos + 5
    }
  }
  throw new Error('compact-size too large')
}
