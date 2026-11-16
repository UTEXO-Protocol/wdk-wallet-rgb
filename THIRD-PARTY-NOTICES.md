# Third-party notices

The WDK adapter is licensed under [Apache-2.0](LICENSE). Its dependencies retain
their own licenses. The npm distribution and the separately distributed Node
workers must include this file, [the collected license and attribution
texts](THIRD-PARTY-LICENSES.txt), and [the dependency
inventory](third-party-dependencies.json).

The inventory records exact versions, source locations, declared license
expressions, authors when supplied, and SHA-256 references to the original notice
texts. The text collection preserves dependency license and NOTICE files,
including those shipped with bundled cryptographic and C libraries. Identical
texts are stored once and mapped to each package that supplies them.

## Scope

The native inventory is the union of the locked Node and Bare Cargo resolve
graphs. It deliberately includes build dependencies and target-conditional
packages; listing a package does not mean it is linked into every binary. The
JavaScript inventory includes production dependencies from `package-lock.json`,
including transitive packages. Dependencies installed separately through npm
also retain their own license files.

This collection covers the source and dependency versions used to build the WDK
artifacts. It does not cover an application's additional dependencies, the Bare
host runtime distributed by the application, or the operating system/toolchain
runtime. Application distributors must retain the applicable notices for those
components as well.

Some published crates declare an SPDX license but omit a license file. Those
entries are explicitly marked
`standard-text-package-omits-license-file` in the inventory. They include the
declared standard license text from the pinned SPDX license-list data and any
author metadata supplied by the package. This does not invent a copyright year,
replace a package-specific notice, or claim the upstream archive contained a
file that was absent. Shared license files above a Git workspace member are
marked `workspace` and retained from that exact checkout.

## Source availability

The unmodified MPL-covered dependencies are available as exact source archives:

| Dependency | License | Corresponding source |
| --- | --- | --- |
| `base85 2.0.0` | MPL-2.0, without the secondary-license exception | [base85-2.0.0.crate](https://static.crates.io/crates/base85/base85-2.0.0.crate) |
| `webpki-roots 0.25.4` | MPL-2.0 | [webpki-roots-0.25.4.crate](https://static.crates.io/crates/webpki-roots/webpki-roots-0.25.4.crate) |

Their MPL text is included in the license collection. The inventory also gives
the source archive for every registry crate and the exact repository revision
for every Git dependency. Cargo registry checksums are retained in the two
locked native dependency graphs identified by the inventory. WDK does not
modify these dependency source files. The private BFA fork is MIT-licensed; its
supplied license text and exact source revision are retained in the inventory.

## Reproduction

With the exact native source prepared and the locked Cargo sources cached:

```sh
npm ci --omit=dev --ignore-scripts
python3 scripts/generate-third-party-notices.py
python3 scripts/generate-third-party-notices.py --check
```

Use `--npm-root /path/to/isolated/install` when the local workspace has a
different dependency installation. That directory must contain production
dependencies installed from this repository's lockfile. Generation rejects an
installed package with a different version. It runs Cargo metadata offline with
`--locked`; it neither changes dependency versions nor compiles them.

The lightweight `--check` verifies the committed collection against both Cargo
locks, the npm lock, the RGB source pin and the notice-text digest. Regenerate
the collection whenever those inputs change. This inventory records source
license declarations and distributed notices; it is not a representation that
upstream dependencies are free of defects or that every application distribution
has completed its own license review.
