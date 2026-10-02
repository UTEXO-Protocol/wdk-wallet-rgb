// BareSigner — Bare worklet implementation of ISigner.
//
// Uses @utexo/rgb-sdk's pure-JS PSBT signer (signPsbtFromSeed) which supports
// BIP86 Taproot signing with RGB-specific preprocessing. This lets us sign
// PSBTs returned by rgb-lib's sendBtcBegin/sendBegin flows even when the
// underlying rgb-lib wallet is watch-only (mnemonic: null).
//
// Message signing/verification use @utexo/rgb-sdk-core's shared crypto.

import { signMessage, verifyMessage } from '@utexo/rgb-sdk-core'
import { signPsbtFromSeed, signPsbt as signPsbtFromMnemonic } from '@utexo/rgb-sdk'

/** @implements {import('@utexo/rgb-sdk-core').ISigner} */
export class BareSigner {
  constructor (binding) {
    this._binding = binding
  }

  async signPsbtWithMnemonic (mnemonic, psbt, network) {
    return signPsbtFromMnemonic(mnemonic, psbt, network)
  }

  async signPsbtWithSeed (seed, psbt, network) {
    return signPsbtFromSeed(seed, psbt, network)
  }

  async signMessage (params) {
    return signMessage(params)
  }

  async verifyMessage (params) {
    return verifyMessage(params)
  }

  async estimateFee (psbt) {
    // rgb-sdk's main bundle does not export estimatePsbt, so delegate
    // to the binding's PSBT-size-based estimate (BareRgbLibBinding.
    // estimateFee). Returning zeros here would make every
    // WalletAccountRgb.sendTransaction() report fee: 0n even though
    // the broadcast tx pays a real fee.
    if (this._binding && typeof this._binding.estimateFee === 'function') {
      return this._binding.estimateFee(psbt)
    }
    const sizeBytes = psbt.length * 3 / 4
    const vbytes = Math.ceil(sizeBytes * 0.4)
    const feeRate = this._binding && typeof this._binding.estimateFeeRate === 'function'
      ? await this._binding.estimateFeeRate(1)
      : 1
    return { fee: Math.ceil(vbytes * feeRate), vbytes, feeRate }
  }
}
