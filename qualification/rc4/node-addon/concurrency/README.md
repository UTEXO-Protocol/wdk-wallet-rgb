# Packed Node concurrency acceptance

Install the exact reviewed archive into a clean consumer without lifecycle scripts,
then run this harness with a supported Node version:

```sh
npm install --ignore-scripts /path/to/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz
node /path/to/run.mjs ./node_modules/@utexo/wdk-wallet-rgb result.json /path/to/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz
```

Keep `worker.mjs` next to `run.mjs`. The optional last argument records the
archive's SHA-256; the harness does not install or extract it. Verify the archive
against the reviewed release digest before installing. The runner independently
checks the selected addon against the installed package's native manifest.

Four independent manager isolates each start a real native worker. The test
covers simultaneous offline wallet creation, reads and BIP-322, native ownership
rejection across isolates, partial teardown while other wallets remain live, and
reopening all four identities after complete teardown. It uses normal addon
discovery without an explicit addon path or hash override.

All wallets are temporary and unfunded. Seeds remain in memory, workers are
closed and wallet directories removed. No indexer, proxy or hosted bridge is
contacted. A pass qualifies this host and package for this concurrency scope;
funded settlement and other platforms require separate acceptance.
