# Releasing the on-chain SDK

The prepared version is `3.0.0-rc.4`. Version 3 breaks from 2.x; RC4 preserves RC3 wallet directories and requires in-place upgrade qualification. The npm distribution tag is `next`, not `latest`. This procedure does not authorize publication, merging, tags or a GitHub Release; those require the release owner's instruction.

## What is being released

One npm archive contains the JavaScript/types, documentation/notices and eleven Bare addons. Five separate Node worker archives carry the native executables and the same notices. Node applications select their worker explicitly and configure its absolute path and SHA-256. Installing the npm archive never downloads or builds native code.

All binaries must use the exact public RGB-Tools rgb-lib commit and registry protocol graph recorded in the native manifest and locks. The candidate pins `a62fc7d3aa21f715a53c32419ab6d9fbbf1721a2`, the pending [upstream PR #138](https://github.com/RGB-Tools/rgb-lib/pull/138) repair atop `f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`, including merged public contract API PR #124. It is not yet an upstream release. No downstream Cargo source overrides or source-file patches are applied. Keep the prepared source clean. The remaining Esplora TLS findings are recorded in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md); they are not fixed or hidden by this candidate.

## Build and qualification

1. Start with a clean, reviewed commit. Run `npm ci --ignore-scripts`, `npm test`, `npm run check:types`, the release-tool regression tests, the source-only package check, and the locked Rust release tests. Use Rust 1.94.0 and Bare 1.37.1 or newer as specified by the build.
2. Run the complete native matrix in `.github/workflows/build.yml`. The pinned public dependency requires no private source credential. Require success for all five Node workers and eleven Bare addons. A skipped native matrix does not satisfy this step.
3. Download each artifact from that exact producer commit. Verify GitHub's archive digest, the binary hash and the platform receipt. Record all identities in the committed platform receipt. Admit all eleven Bare hashes in `src/onchain-bare-native.json`; do not rename an older mobile library to impersonate a new version.
4. Stage all eleven addons with `scripts/stage-bare.mjs`, then run `node scripts/check-candidate-pack.mjs --require-all-targets`. A source-only archive is not the release package. Pack from committed source with `npm pack --ignore-scripts --pack-destination <directory>`.
5. Install that tarball into clean Node and Bare consumers. Execute the selected worker/addon, verify hash rejection and its native handshake, and run the funded ordinary RGB, BTC, BFA mint/burn/proof recovery and distinct-proxy tests on isolated fixtures. Also upgrade an old RC3 funded wallet in place: verify balances, pending invoices, allocations, interrupted operations and proof bytes after repeated reopen. Install the application update over the distributed baseline using the same package identity and signing key; fresh-wallet tests alone do not qualify that update. Retain evidence for the exact archive and binaries. A funded host pack may qualify the complete archive only when an independent comparison proves identical runtime files, dependency metadata, native manifest identity and host binary bytes; record permitted documentation/target additions and still run fresh consumers of the complete archive. Build/ABI checks on mobile do not substitute for installed-app acceptance.
6. While an upstream dependency or publication approval is pending, verify the complete candidate without assembling release assets:

```sh
python3 scripts/prepare-release.py \
  --verify-qualification \
  --qualification qualification/rc4/platforms.json \
  --archive /absolute/path/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz \
  --artifacts /absolute/path/native-artifacts
```

This checks committed source, all sixteen binaries and every packed file. It reports `publicationAllowed: false` and rejects `--output`. It still rejects a native artifact admission hold. It cannot clear a hold or publish a package.

7. After upstream acceptance and review of hold removal, generate the complete local delivery set:

```sh
python3 scripts/prepare-release.py \
  --qualification qualification/rc4/platforms.json \
  --archive /absolute/path/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz \
  --artifacts /absolute/path/native-artifacts \
  --output /absolute/path/new-release-directory
```

Qualification-only candidates retain `publicationHold: true`; the release tool must reject them. Remove that hold in a reviewed commit only after upstream #138 is accepted, the release owner accepts the documented dependency policy, and every target and consumer check is complete. Do not temporarily remove it to run a qualification check.

The artifact root contains `node-<target>` and `bare-<target>` directories. The tool requires a clean checkout, committed source identities, exact package inventory, all sixteen targets and unchanged native inputs since the producer. It emits five deterministic Node archives, the npm archive, `SHA256SUMS` and a release manifest. It rejects stale or missing binaries, unadmitted package files and unsafe archive entries. It does not publish anything.

## PR and application order

1. Obtain upstream review of [RGB-Tools #138](https://github.com/RGB-Tools/rgb-lib/pull/138). After its merge, verify the accepted commit/tree against the candidate and repin/rebuild if the exact source identity changes. Do not remove the repair: uncorrected master can fail to list an existing BFA asset after upgrading its database.
2. Review and finalize [SDK #23](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/pull/23). Keep the release/publication holds until the exact rebuilt matrix, in-place upgrade and application acceptance pass and the release owner accepts the documented risks. After that acceptance, commit and review hold removal as part of finalization. Merge with a normal merge commit: `verify_source()` requires the reviewed native producer to remain an ancestor of the release source. Squashing or rebasing this branch would require changing and requalifying that provenance procedure before its artifacts could be admitted.
3. Assemble the delivery set from the final committed release source with the holds cleared. Removing a hold changes a packed file, so the qualification archive's checksum cannot identify the release archive. Repack, verify all source and native identities, and repeat packed-consumer checks. The existing admitted binaries can be reused only while the SDK version and native build inputs remain unchanged. A version bump requires rebuilt versioned mobile libraries.
4. Publish the verified `3.0.0-rc.4` archive under `next` and attach the five matching Node worker archives, `SHA256SUMS` and release manifest to the GitHub Release. npm alone does not deliver the Node workers.
5. Update [Iris #11](https://github.com/UTEXO-Protocol/utexo-mobile/pull/11) from its frozen local archive to the exact published version and integrity. Update the coupled package/source/profile pins, admit the registry package, then rebuild and test that final application integration before merging it into `dev`. Iris #10 is already contained in #11 and needs no separate merge.

The application qualification uses WebRGB and WalletConnect `0.1.7`; a newer wire protocol needs separate compatibility qualification. The required transport/bridge changes and RGB-Tools public contract API #124 are merged. The former Lightning dependency stack and superseded contract API #103 are not release dependencies.

## Publication, when authorized

- Obtain the required PR review and merge approval. Revalidate source equivalence and the assembled release set against the reviewed release commit. If native inputs or the package version changed, rebuild affected binaries and repeat admission; do not silently reuse earlier versioned mobile libraries.
- Authenticate with the release owner's npm maintainer account and check `npm whoami`, `npm access list packages`, and `npm view @utexo/wdk-wallet-rgb versions dist-tags --json`. Confirm organization publication rights and that `3.0.0-rc.4` is unused. An anonymous 404 does not establish package ownership or availability. Do not place credentials in source, logs or assets.
- Resolve the repository's required reviews on the final commit. Use a normal merge; do not rewrite the admitted producer ancestry. Inspect the merged source before making the tag.
- Use maintainer 2FA or the organization's approved npm publication authentication. No repository workflow publishes this package automatically.
- Publish only the verified tarball: `npm publish /absolute/path/utexo-wdk-wallet-rgb-3.0.0-rc.4.tgz --access public --tag next`. Do not publish a source-only checkout or promote this release candidate to `latest`.
- Create the matching Git tag and GitHub Release from the reviewed source, attach the complete verified delivery set and use `RELEASE-NOTES.md`. Record registry integrity, final URLs and checksums.
- Install the published tarball as a fresh consumer and compare its bytes/integrity with the approved local archive. Verify the downloaded Node worker archives independently. No rebuild should occur during installation.

Stable `3.0.0` is a separate release decision. Its versioned mobile libraries must be built and admitted for that version. Application/device acceptance and hosted settlement claims must have their own evidence before they are advertised.

## Scope and non-goals

The release candidate supports the APIs documented in `onchain.d.ts` and `webrgb-onchain.d.ts`, including standalone public contract registration/export. It does not promise every upstream RGB API or the old wrapper's aliases. Automatic VSS restore, a legacy 2.x wallet-data converter and Mainnet BFA are not advertised capabilities. Ordinary BTC/NIA/CFA wallet operation does not depend on those features. Cancellation exclusions and ambiguous signed-input reservations are financial protections, not temporary release switches.

The package contains no deployment-specific USDT export, seed, proxy credential or wallet data. Preserve the complete RGB wallet directory, including the operation/input journals, for recovery.
