#!/usr/bin/env python3
"""Run local Dev Signet and guarded HTTP tests with the SDK Cargo lock."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PREPARED = ROOT / ".sources" / "rgb-lib-bfa-bare"
ESPLORA = ROOT / ".sources" / "esplora-client"


def expose_egress_fixtures(egress):
    names = (
        "public_urls_reject_nonpublic_destinations_and_ambiguous_authority",
        "regtest_admits_only_loopback",
        "dns_filters_the_actual_address_pool_and_refuses_mixed_answers",
    )
    source = egress.read_text()
    module = '#[cfg(test)]\nmod tests {'
    if source.count(module) != 1:
        raise SystemExit("The prepared overlay lacks the guarded HTTP test module.")
    source = source.replace(module, 'pub(crate) mod tests {', 1)
    for name in names:
        signature = f'    #[test]\n    fn {name}()'
        if source.count(signature) != 1:
            raise SystemExit(f"The prepared overlay lacks guarded HTTP test {name}.")
        source = source.replace(signature, f'    pub(crate) fn {name}()', 1)
    egress.write_text(source)
    checks = ''.join(f'    crate::api::egress::tests::{name}();\n' for name in names)
    return '\n#[doc(hidden)]\npub fn run_egress_fixtures() {\n' + checks + '}\n'


def run_loopback_test(work):
    fixture_rgb = work / ".sources" / PREPARED.name
    for prepared in (PREPARED, ESPLORA):
        shutil.copytree(prepared, work / ".sources" / prepared.name,
                        ignore=shutil.ignore_patterns(".git", "target"))
    # Give both test packages their own Cargo identity. A shared target cache
    # must never supply this fixture's RGB library or stub main to a real build.
    rgb_manifest = fixture_rgb / "Cargo.toml"
    rgb_manifest.write_text(
        rgb_manifest.read_text().replace('name = "rgb-lib"', 'name = "rgb-lib-dev-fixture"', 1)
    )
    manifest = (ROOT / "Cargo.toml").read_text()
    (work / "Cargo.toml").write_text(
        manifest.replace('name = "utexo-rgb-native"', 'name = "utexo-rgb-native-dev-fixture"', 1)
        .replace("rgb-lib = { path = ", 'rgb-lib = { package = "rgb-lib-dev-fixture", path = ', 1)
    )
    lock = (ROOT / "Cargo.lock").read_text()
    (work / "Cargo.lock").write_text(
        lock.replace('"rgb-lib"', '"rgb-lib-dev-fixture"')
        .replace('"utexo-rgb-native"', '"utexo-rgb-native-dev-fixture"')
    )
    (work / "src").mkdir()
    (work / "src/main.rs").write_text("fn main() {}\n")
    (work / "tests").mkdir()
    (work / "tests/checkpoint.rs").write_text(
        "#[test]\nfn rgb_dev_electrum_checkpoint() { rgb_lib::no_wallet::run_dev_signet_fixture(); }\n"
        "#[test]\nfn rgb_dev_esplora_checkpoint() { rgb_lib::no_wallet::run_dev_signet_esplora_fixture(); }\n"
        "#[test]\nfn rgb_guarded_http_policy() { rgb_lib::no_wallet::run_egress_fixtures(); }\n"
        "#[test]\nfn recovered_colored_outputs_require_provenance() { rgb_lib::wallet::run_verified_colored_outputs_fixture(); }\n"
    )

    validation = fixture_rgb / "src/no_wallet/validation.rs"
    source = validation.read_text()
    # Cargo builds rgb-lib as a dependency without cfg(test). Expose its existing
    # loopback-only exception in this temporary fixture copy.
    for condition in (
        'url.starts_with("tcp://127.0.0.1:")',
        'endpoint.scheme() == "http" && endpoint.host_str() == Some("127.0.0.1")',
    ):
        transport = f"    #[cfg(test)]\n    if {condition} {{"
        if source.count(transport) != 1:
            raise SystemExit("The prepared overlay lacks an expected loopback guard.")
        source = source.replace(transport, transport.split("\n", 1)[1])
    constants = "\n".join(
        next(line for line in source.splitlines() if line.startswith(f"    const {name}:"))
        for name in ("DEV_HEADER", "PUBLIC_HEADER")
    )
    signature = "    #[test]\n    fn dev_signet_checkpoint_checks_indexer_and_witness_resolver_independently()"
    start = source.index('    #[cfg(feature = "electrum")]\n' + signature)
    end = source.index("\n}", start)
    fixture = source[start:end].replace(signature, "    pub(crate) fn run()", 1)
    module_signature = "\npub(crate) mod dev_signet_esplora_fixture {"
    test_cfg = '#[cfg(all(test, feature = "esplora"))]' + module_signature
    if source.count(test_cfg) != 1:
        raise SystemExit("The prepared overlay lacks the expected Esplora fixture module.")
    source = source.replace(test_cfg, '#[cfg(feature = "esplora")]' + module_signature)
    validation.write_text(
        source + '\n#[cfg(feature = "electrum")]\npub(crate) mod dev_signet_fixture {\n'
        + "    use super::*;\n" + constants + "\n" + fixture + "\n}\n"
    )
    module = fixture_rgb / "src/no_wallet/mod.rs"
    module.write_text(
        module.read_text()
        + "\n#[doc(hidden)]\npub fn run_dev_signet_fixture() { validation::dev_signet_fixture::run(); }\n"
        + "\n#[doc(hidden)]\npub fn run_dev_signet_esplora_fixture() { validation::dev_signet_esplora_fixture::run(); }\n"
        + expose_egress_fixtures(fixture_rgb / "src/api/egress.rs")
    )
    core = fixture_rgb / "src/wallet/core.rs"
    core.write_text(
        core.read_text()
        + "\n" + (ROOT / "tests/fixtures/verified-colored-outputs.rs").read_text()
    )
    wallet = fixture_rgb / "src/wallet/mod.rs"
    wallet.write_text(
        wallet.read_text()
        + "\n#[doc(hidden)]\npub fn run_verified_colored_outputs_fixture() { core::run_verified_colored_outputs_fixture(); }\n"
    )
    subprocess.run(
        [
            "cargo", "+1.94.0", "test", "--release", "--offline", "--locked", "-j", "2",
            "--manifest-path", str(work / "Cargo.toml"), "--test", "checkpoint",
        ],
        check=True,
    )


if __name__ == "__main__":
    if not PREPARED.is_dir() or not ESPLORA.is_dir():
        raise SystemExit("Prepare the pinned Bare RGB and Esplora sources before running this offline check.")
    subprocess.run([sys.executable, str(ROOT / "scripts/prepare-source.py"), "--bare"], check=True)
    with tempfile.TemporaryDirectory(prefix="iris-rgb-checkpoint-test.") as scratch:
        run_loopback_test(Path(scratch))
