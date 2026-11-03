#!/usr/bin/env python3
"""Run the exact prepared overlay's isolated mint conservation unit test."""
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
subprocess.run([sys.executable, str(ROOT / "scripts/prepare-source.py"), "--bare"], check=True)
source = (ROOT / ".sources/rgb-lib-bfa-bare/src/wallet/online.rs").read_text()
start = source.index("fn mint_amount_matches(")
end = source.index("/// Parse and validate the [`OnlineOptions::proxy_auth_keys`]", start)
with tempfile.TemporaryDirectory() as work:
    unit = Path(work) / "mint.rs"
    binary = Path(work) / "test"
    unit.write_text(source[start:end])
    subprocess.run(["rustc", "+1.94.0", "--edition", "2024", "--test", str(unit), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
