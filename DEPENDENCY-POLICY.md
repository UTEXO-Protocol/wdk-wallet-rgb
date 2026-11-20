# Dependency policy for the unmodified upstream candidate

RC3 uses public RGB-Tools rgb-lib `0.3.0-beta.8`, commit
`567e5b8308f70a6242137475394be5a82fc15c95`, tree
`8a887b28bd12625e36cd7cfe2af067ff766ece1d`. The source is unmodified and its
RGB protocol dependencies are locked registry `0.11.2-rc.2` packages. The RC3
Node and Bare graphs both use SQLx `0.9.1` and bundled `libsqlite3-sys 0.40.0`
(SQLite `3.54.1`). They therefore exclude the SQLite finding listed in the
historical RC2 acceptance below. Both locked native audits retain seven TLS
findings and the upstream YAML maintenance warning. The qualification pack
remains on publication hold; those findings are not represented as fixed or
suppressed.

The old TLS branch is `bdk_esplora 0.22.3` / `rgb-ops 0.11.2-rc.2` through
`esplora-client 0.12.3` and `minreq 2.14.1`. It fixes Rustls to the `0.21` line,
webpki to `0.101`, and the root store to `0.25`. The application does not provide
a custom session store that formats session secrets or configure CRLs. That
removes the known prerequisites for the session-Debug and CRL-parser findings
from this configuration. This Rustls branch offers classical key exchange only;
it does not make a post-quantum guarantee.

The certificate name-constraint and emSign trust findings remain relevant to the
Esplora HTTPS verifier. They are not dismissed as logging issues. Adding a newer
direct Rustls dependency or enabling native TLS does not replace this forced
branch: minreq selects Rustls when both TLS features are enabled. Upstream
Esplora `0.13.0` and minreq `3.0.0` exist, but BDK's current compatible dependency
range does not admit them. A compatible upstream BDK/RGB resolver release or a
maintained minreq `2.x` backport is needed to remove this branch without source
patches. [minreq implementation](https://docs.rs/minreq/2.14.1/src/minreq/connection/rustls_stream.rs.html)
· [emSign verifier advisory](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)
· [SQLite advisory](https://rustsec.org/advisories/RUSTSEC-2026-0459.html).

## Recorded RC2 acceptance

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

The [recorded audit](qualification/rc1/dependency-audit.json) identifies the
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
