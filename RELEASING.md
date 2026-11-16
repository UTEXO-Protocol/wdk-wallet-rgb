# Releasing the on-chain SDK

The prepared version is `3.0.0-rc.2`. Version 3 makes the API and wallet-directory break explicit. The npm distribution tag is `next`, not `latest`. This procedure does not authorize publication, merging, tags or a GitHub Release; those require the release owner's instruction.

## What is being released

One npm archive contains the JavaScript/types, documentation/notices and eleven Bare addons. Five separate Node worker archives carry the native executables and the same notices. Node applications select their worker explicitly and configure its absolute path and SHA-256. Installing the npm archive never downloads or builds native code.

All binaries use the unmodified BFA.8 commit and locked dependency graph recorded in the native manifest. The Cargo source overrides select the protocol revisions required by BFA.8; they do not patch the dependency's files. Keep the prepared upstream source clean. The accepted stock dependency risks are recorded in [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md); they are not fixed or hidden by this release.

## Build and qualification

1. Start with a clean, reviewed commit. Run `npm ci --ignore-scripts`, `npm test`, `npm run check:types`, the release-tool regression tests, the source-only package check, and the locked Rust release tests. Use Rust 1.94.0 and Bare 1.37.1 or newer as specified by the build.
2. Run the complete native matrix in `.github/workflows/build.yml`. The private dependency is fetched with `ORG_READ_TOKEN`; build tools do not receive that credential. Require success for all five Node workers and eleven Bare addons. A skipped native matrix does not satisfy this step.
3. Download each artifact from that exact producer commit. Verify GitHub's archive digest, the binary hash and the platform receipt. Record all identities in the committed platform receipt. Admit all eleven Bare hashes in `src/onchain-bare-native.json`; do not rename an older mobile library to impersonate a new version.
4. Stage all eleven addons with `scripts/stage-bare.mjs`, then run `node scripts/check-candidate-pack.mjs --require-all-targets`. A source-only archive is not the release package. Pack from committed source with `npm pack --ignore-scripts --pack-destination <directory>`.
5. Install that tarball into clean Node and Bare consumers. Execute the selected worker/addon, verify hash rejection and its native handshake, and run the funded ordinary RGB, BTC, BFA mint/burn/proof recovery and distinct-proxy tests on isolated fixtures. Retain evidence for the exact archive and binaries. A funded host pack may qualify the complete archive only when an independent comparison proves identical runtime files, dependency metadata, native manifest identity and host binary bytes; record permitted documentation/target additions and still run fresh consumers of the complete archive. Build/ABI checks on mobile do not substitute for installed-app acceptance.
6. Generate the complete local delivery set:

```sh
python3 scripts/prepare-release.py \
  --qualification qualification/rc2/platforms.json \
  --archive /absolute/path/utexo-wdk-wallet-rgb-3.0.0-rc.2.tgz \
  --artifacts /absolute/path/native-artifacts \
  --output /absolute/path/new-release-directory
```

The artifact root contains `node-<target>` and `bare-<target>` directories. The tool requires a clean checkout, committed source identities, exact package inventory, all sixteen targets and unchanged native inputs since the producer. It emits five deterministic Node archives, the npm archive, `SHA256SUMS` and a release manifest. It rejects stale or missing binaries, unadmitted package files and unsafe archive entries. It does not publish anything.

## Publication, when authorized

- Obtain the required PR review and merge approval. Revalidate source equivalence and the assembled release set against the reviewed release commit. If native inputs or the package version changed, rebuild affected binaries and repeat admission; do not silently reuse earlier versioned mobile libraries.
- Verify registry identity/access with the release owner's maintainer account. Registry lookup is not publication authorization. Do not place credentials in source, CI logs or release assets.
- Publish the verified npm tarball with the `next` tag. Do not publish a checkout containing only JavaScript or promote this release candidate to `latest`.
- Create the matching Git tag and GitHub Release from the reviewed source, attach the complete verified delivery set and use `RELEASE-NOTES.md`. Record registry integrity, final URLs and checksums.
- Install the published tarball as a fresh consumer and compare its bytes/integrity with the approved local archive. Verify the downloaded Node worker archives independently. No rebuild should occur during installation.

Stable `3.0.0` is a separate release decision. Its versioned mobile libraries must be built and admitted for that version. Application/device acceptance and hosted settlement claims must have their own evidence before they are advertised.

## Scope and non-goals

The release candidate supports the APIs documented in `onchain.d.ts` and `webrgb-onchain.d.ts`. It does not promise every upstream RGB API or the old wrapper's aliases. Contract preregistration, automatic VSS restore, a legacy wallet-data converter and Mainnet BFA are not advertised capabilities. Ordinary BTC/NIA/CFA wallet operation does not depend on those features. Cancellation exclusions and ambiguous signed-input reservations are financial protections, not temporary release switches.

The package contains no deployment-specific USDT export, seed, proxy credential or wallet data. Preserve the complete RGB wallet directory, including the operation/input journals, for recovery.
