// Copyright 2026 UTEXO. Licensed under the Apache License, Version 2.0.
import { registerHooks } from 'node:module'
import nativeManifest from '../../src/onchain-bare-native.json' with { type: 'json' }

// Synthetic workers and the release-hold regression use an explicit manifest.
export async function importWalletFixture (name, releaseHold = false) {
  const wallet = new URL('../../src/onchain-wallet.js?native-fixture=' + name, import.meta.url).href
  const manifest = new URL('../../src/onchain-bare-native.json', import.meta.url).href
  const fixture = 'data:application/json,' + encodeURIComponent(JSON.stringify({ ...nativeManifest, releaseHold }))
  const hooks = registerHooks({
    resolve (specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (context.parentURL === wallet && resolved.url === manifest) {
        return { ...resolved, url: fixture, shortCircuit: true }
      }
      return resolved
    }
  })
  try { return await import(wallet) } finally { hooks.deregister() }
}
