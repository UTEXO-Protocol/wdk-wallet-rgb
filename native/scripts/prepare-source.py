#!/usr/bin/env python3
"""Prepare and verify the private build source. Never used at consumer install."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / ".sources" / "rgb-lib-upstream"
SOURCE_URL = "https://github.com/RGB-Tools/rgb-lib.git"
SHA = "f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d"
BASE_TREE = "0c20cd05eb2899962c152b6ccac324e2a705dc38"

def git(repo, *args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args], text=True).strip()

def verify(repo):
    if (git(repo, "rev-parse", "HEAD") != SHA
        or git(repo, "rev-parse", "HEAD^{tree}") != BASE_TREE
        or git(repo, "write-tree") != BASE_TREE
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others")):
        raise SystemExit("RGB build source does not match the exact unmodified upstream tree")

def main():
    os.umask(0o077)
    args = sys.argv[1:]
    if args and args[0] in ("--bare", "--rgb-source-only"):
        args.pop(0)
    if len(args) > 1:
        raise SystemExit("usage: prepare-source.py [--bare | --rgb-source-only] [source]")
    # Compilation verifies sources; artifact admission is checked when staging/packing.
    manifest = json.loads((ROOT.parent / "src/onchain-bare-native.json").read_text())
    if (manifest["source"], manifest["overlayTree"], manifest["integrationTree"]) != (
        SHA, BASE_TREE, BASE_TREE
    ):
        raise SystemExit("Native manifest does not pin the unmodified upstream RGB source")
    dest = DEST
    if dest.exists():
        verify(dest)
        return
    dest.parent.mkdir(exist_ok=True)
    source = SOURCE_URL
    credentials = ["-c", "credential.helper=", "-c", "http.followRedirects=false"]
    if args:
        # Local fixture and offline source mirrors use the same commit/tree admission.
        local = Path(args[0]).resolve(strict=True)
        if not local.is_dir():
            raise SystemExit("Source override must be an existing local Git directory")
        source = str(local)
    with tempfile.TemporaryDirectory(dir=dest.parent) as work:
        staged = Path(work) / "candidate"
        staged.mkdir()
        git(staged, "init", "--quiet")
        git(staged, *credentials, "fetch", "--quiet", "--depth=1", "--no-tags", source, SHA)
        git(staged, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        verify(staged)
        # A concurrently promoted directory is nonempty; rename then fails closed.
        staged.rename(dest)
    verify(dest)

if __name__ == "__main__":
    main()
