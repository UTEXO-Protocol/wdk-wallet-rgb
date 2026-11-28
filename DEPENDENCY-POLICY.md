# Dependency policy

RC4 uses unmodified public RGB-Tools rgb-lib commit
`f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d`, tree
`0c20cd05eb2899962c152b6ccac324e2a705dc38`. It includes the merged public
contract import/export API from PR #124.
The crate labels itself `0.3.0-beta.7`; the commit identifies the source.
The locked RGB protocol dependencies are registry `0.11.2-rc.2` packages.
WDK applies no downstream source patches or Cargo source overrides.

## Current audit

The [RC4 audit receipt](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/candidate/onchain-bfa/qualification/rc4/dependency-audit.json) records both
native lock hashes, the RustSec database revision and the npm runtime audit.
The November 27, 2026 refresh found a new `url 2.5.8` denial-of-service advisory:
[RUSTSEC-2026-0592](https://rustsec.org/advisories/RUSTSEC-2026-0592.html).
RC4 updates both locks to `url 2.5.9` and its required `form_urlencoded 1.2.3`
without changing the RGB source or other dependencies. All sixteen native
artifacts must be rebuilt and admitted against those locks.

Both updated native graphs retain **seven TLS findings and two maintenance
warnings**. The JavaScript production audit reports **zero known findings**;
that result does not clear the native findings. No advisory is suppressed.

| Dependency | Finding | Exposure and disposition |
| --- | --- | --- |
| `rustls 0.21.12` | `RUSTSEC-2026-0346`, `RUSTSEC-2026-0349` | The client has no custom session store that formats session secrets. This branch provides classical key exchange only, with no post-quantum guarantee. The dependency remains unchanged. |
| `rustls-webpki 0.101.7` | `RUSTSEC-2026-0104`, `RUSTSEC-2026-0098`, `RUSTSEC-2026-0099`, `RUSTSEC-2026-0382` | Stock Esplora HTTPS uses this verifier. Certificate name constraints and distrusted emSign intermediates remain relevant. This configuration does not supply CRLs. The dependency remains unchanged. |
| `webpki-roots 0.25.4` | `RUSTSEC-2026-0381` | The Esplora trust store includes the affected emSign root. The dependency remains unchanged. |
| `chrono 0.4.45` | `RUSTSEC-2026-0543`, unmaintained | Newly recorded by this database refresh. Upstream RGB/database dependencies use it; replacing it requires upstream API changes. This maintenance warning is not reported as a demonstrated wallet exploit. |
| `unsafe-libyaml 0.2.11` | `RUSTSEC-2024-0449`, unmaintained | The upstream YAML dependency is retained. This maintenance warning is not reported as a demonstrated wallet exploit. |

The retained TLS branch comes through `bdk_esplora 0.22.3` / `rgb-ops 0.11.2-rc.2`,
`esplora-client 0.12.3` and `minreq 2.14.1`. Adding a newer direct Rustls dependency
or enabling native TLS does not replace that branch: minreq selects Rustls when
both TLS features are enabled. Removing it without source patches requires a
compatible maintained upstream dependency graph. See the [minreq implementation](https://docs.rs/minreq/2.14.1/src/minreq/connection/rustls_stream.rs.html)
and [emSign verifier advisory](https://rustsec.org/advisories/RUSTSEC-2026-0382.html).

The previous SQLite finding, `RUSTSEC-2026-0459`, is absent: both graphs use
`libsqlite3-sys 0.40.0`, bundling SQLite `3.54.1`, through SQLx `0.9.1`.
The URL finding is also absent after the compatible registry update. Neither
change clears the retained TLS findings.

## Release handling

On November 16, 2026, the release owner directed WDK to use unmodified upstream
sources and accepted the then-reported TLS and SQLite findings. The
[historical audit](https://github.com/UTEXO-Protocol/wdk-wallet-rgb/blob/a6dd195b3988b6fccd70dce9a66c2577ac368853/qualification/rc1/dependency-audit.json)
remains available in Git history. That decision is not a blanket waiver for new
advisories; the refreshed receipt records the URL fix and newly reported chrono
maintenance warning separately.

Keep the current audit, dependency inventory and native identities with release
evidence. Refresh the audit before publication, reassess any new findings and
rebuild when native locks change. Functional tests do not establish that these
dependencies are free of defects. This first release is qualified on fresh
wallets. Reopening current wallet state and recovering interrupted operations
remain required; upgrading older
qualification databases is outside this release scope.
