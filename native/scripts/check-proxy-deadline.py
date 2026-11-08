#!/usr/bin/env python3
"""Offline expiry/ACK/SQLite safety tests using the exact admitted RGB overlay.

The production source is verified and never edited. A disposable copy exposes
only its existing cfg(test) fixture, under different Cargo package identities so
shared build caches cannot leak fixture code into real artifacts. The HTTP test
uses native Regtest loopback admission; it makes no hosted request and adds no
transport exception. Policy tests also compile directly from the production
module with overflow checks enabled.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parent.parent
PREPARED=ROOT/'.sources/rgb-lib-bfa-bare'
ESPLORA=ROOT/'.sources/esplora-client'

def run(work):
    policy=PREPARED/'src/wallet/proxy_deadline.rs'
    executable=work/'policy-tests'
    subprocess.run(['rustc','+1.94.0','--edition','2024','--test',str(policy),'-C','overflow-checks=yes','-o',str(executable)],check=True)
    subprocess.run([str(executable)],check=True)
    for prepared in [PREPARED,ESPLORA]:
        shutil.copytree(prepared,work/'.sources'/prepared.name,ignore=shutil.ignore_patterns('.git','target'))
    rgb=work/'.sources'/PREPARED.name
    p=rgb/'Cargo.toml'
    p.write_text(p.read_text().replace('name = "rgb-lib"','name = "rgb-lib-expiry-fixture"',1))
    manifest=(ROOT/'Cargo.toml').read_text()
    (work/'Cargo.toml').write_text(manifest.replace('name = "utexo-rgb-native"','name = "utexo-rgb-native-expiry-fixture"',1).replace('rgb-lib = { path = ','rgb-lib = { package = "rgb-lib-expiry-fixture", path = ',1))
    lock=(ROOT/'Cargo.lock').read_text()
    (work/'Cargo.lock').write_text(lock.replace('"rgb-lib"','"rgb-lib-expiry-fixture"').replace('"utexo-rgb-native"','"utexo-rgb-native-expiry-fixture"'))
    p=rgb/'src/wallet/online.rs'
    source=p.read_text()
    signature='#[cfg(all(test, feature = "_online"))]\npub(crate) mod proxy_deadline_fixture {'
    if source.count(signature)!=1: raise SystemExit('Expected admitted proxy deadline fixture is missing')
    p.write_text(source.replace(signature,'#[cfg(feature = "_online")]\npub(crate) mod proxy_deadline_fixture {',1))
    p=rgb/'src/lib.rs'
    p.write_text(p.read_text()+'\n#[doc(hidden)]\npub fn run_proxy_deadline_fixture() { wallet::online::proxy_deadline_fixture::run(); }\n')
    (work/'src').mkdir();(work/'src/main.rs').write_text('fn main() {}\n')
    (work/'tests').mkdir();(work/'tests/proxy_deadline.rs').write_text('#[test]\nfn actual_proxy_ack_and_persisted_deadline_fail_safety() { rgb_lib::run_proxy_deadline_fixture(); }\n')
    subprocess.run(['cargo','+1.94.0','test','--release','--offline','--locked','-j','2','--manifest-path',str(work/'Cargo.toml'),'--test','proxy_deadline'],check=True)

if __name__=='__main__':
    subprocess.run([sys.executable,str(ROOT/'scripts/prepare-source.py'),'--bare'],check=True)
    with tempfile.TemporaryDirectory(prefix='iris-rgb-expiry-test.') as scratch:
        run(Path(scratch))
