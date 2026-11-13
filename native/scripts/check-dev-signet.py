#!/usr/bin/env python3
"""Test WDK chain checks and stock BFA.8 indexer behavior without modifying sources."""

from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    # Verify the exact upstream checkout before compiling tests against it. No
    # exported test helpers, source copies or patched dependency identities.
    subprocess.run(
        [sys.executable, str(ROOT / "scripts/prepare-source.py"), "--rgb-source-only"],
        check=True,
    )
    command = [
        "cargo", f"+{os.environ.get('RUSTUP_TOOLCHAIN', '1.94.0')}", "test",
        "--release", "--offline", "--locked", "-j", "2",
        "--manifest-path", str(ROOT / "Cargo.toml"),
    ]
    for tests in [
        ["--bin", "utexo-rgb-native", "engine::network::tests::"],
        ["--bin", "utexo-rgb-native", "profile::tests::"],
        ["--test", "dev_signet", "--test", "electrum_checked_reconnect"],
    ]:
        subprocess.run(command + tests, check=True)


if __name__ == "__main__":
    main()
