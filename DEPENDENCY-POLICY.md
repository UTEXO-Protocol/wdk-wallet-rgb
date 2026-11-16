# Dependency acceptance for the stock BFA.8 release candidate

On November 16, 2026, the release owner directed this candidate to use the
unmodified upstream BFA.8 dependency graph and accepted retaining its reported
TLS and SQLite findings. Those dependency changes are not required for this
release. This decision does not say that the findings are fixed, that upstream
has approved this SDK, or that all possible attacks have been ruled out.

The accepted RGB source is
`UTEXO-Protocol/rgb-lib-bfa@2f7b21d8637baad548504ea870deb2c0d4d0a37d`,
tree `5492824f3cf47b4c821dfca8b7a63fed27858486`. The source preparation check
requires that exact unmodified tree. WDK applies no source patches to RGB,
Electrum, Esplora, TLS or SQLite. Cargo's exact RGB protocol repository overrides
select the sources required by BFA.8; they are not local source-file patches.

## Findings retained

The [recorded audit](qualification/alpha24/dependency-audit.json) identifies the
following findings in the locked native graph:

| Dependency | Finding | Candidate exposure and disposition |
| --- | --- | --- |
| `libsqlite3-sys 0.37.0` | `RUSTSEC-2026-0459` | Bundled SQLite can expose stale process memory when opened with a crafted local database/WAL pair. The candidate creates and opens its own wallet databases; importing an untrusted database directory is not a supported recovery interface. The upstream dependency remains unchanged. |
| `rustls 0.21.12` | `RUSTSEC-2026-0346`, `RUSTSEC-2026-0349` | Findings concern session-secret debug output and key-share prediction. Their particular triggering configurations have not been demonstrated in WDK. This is not a finding of non-reachability. The upstream dependency remains unchanged. |
| `rustls-webpki 0.101.7` | `RUSTSEC-2026-0104`, `RUSTSEC-2026-0098`, `RUSTSEC-2026-0099`, `RUSTSEC-2026-0382` | Stock Esplora HTTPS uses this verifier through `minreq`. Name constraints and distrusted emSign intermediates are relevant to that verifier; CRL parsing has not been established as used here. The upstream dependency remains unchanged. |
| `webpki-roots 0.25.4` | `RUSTSEC-2026-0381` | The stock Esplora trust store includes the affected emSign root. The upstream dependency remains unchanged. |
| `unsafe-libyaml 0.2.11` | `RUSTSEC-2024-0449` maintenance warning | The existing upstream YAML dependency is retained. The warning is not described as a demonstrated WDK exploit. |

The eight native audit findings and the YAML maintenance warning remain visible.
They are not suppressed or relabeled as a clean Rust audit. The recorded
JavaScript runtime audit found zero known vulnerabilities; that result does not
override the native audit.

## Release handling

Keep the dependency inventory, native source identity and audit receipt with the
release evidence. Reassess changes to the source pin or dependency locks, and
record any new findings separately; this acceptance is not a blanket waiver for
future dependency versions. A compatible upstream release can be adopted and
qualified without maintaining a WDK fork of the affected libraries.

Functional limitations are separate from this dependency decision. In
particular, a missing upstream contract-import API cannot be made available by
accepting an audit finding. Runtime capabilities and release notes must continue
to describe the APIs actually supported by the unmodified library.
