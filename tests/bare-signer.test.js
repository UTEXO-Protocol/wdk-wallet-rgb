import { describe, expect, jest, test } from '@jest/globals'

import { BareSigner } from '../src/bare-signer.js'

// Any base64 string: the fee estimate is derived from its length.
// 'cHNidF9kYXRh' is 12 chars -> 12*3/4 = 9 bytes -> ceil(9*0.4) = 4 vbytes.
const PSBT = 'cHNidF9kYXRh'

describe('BareSigner.estimateFee', () => {
  test('delegates to the binding so sendTransaction reports the real fee', async () => {
    const binding = {
      estimateFee: jest.fn().mockResolvedValue({ fee: 210, vbytes: 140, feeRate: 1 })
    }
    const signer = new BareSigner(binding)

    const result = await signer.estimateFee(PSBT)

    expect(binding.estimateFee).toHaveBeenCalledWith(PSBT)
    expect(result).toEqual({ fee: 210, vbytes: 140, feeRate: 1 })
    expect(result.fee).toBeGreaterThan(0)
  })

  test('falls back to the PSBT-size formula via estimateFeeRate', async () => {
    const binding = {
      estimateFeeRate: jest.fn().mockResolvedValue(2)
    }
    const signer = new BareSigner(binding)

    const result = await signer.estimateFee(PSBT)

    // 4 vbytes * 2 sat/vbyte = 8 sats
    expect(result).toEqual({ fee: 8, vbytes: 4, feeRate: 2 })
  })

  test('defaults to 1 sat/vbyte when no binding is available', async () => {
    const signer = new BareSigner(null)

    const result = await signer.estimateFee(PSBT)

    expect(result).toEqual({ fee: 4, vbytes: 4, feeRate: 1 })
  })
})
