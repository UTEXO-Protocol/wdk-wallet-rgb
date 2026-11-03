#!/usr/bin/env python3
"""Prepare and verify the private build source. Never used at consumer install."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / ".sources" / "rgb-lib-bfa"
SOURCE_URL = "https://github.com/UTEXO-Protocol/rgb-lib-bfa.git"
PATCH = ROOT / "patches" / "rgb-lib-bfa.5-onchain.patch"
SHA = "0a9d352f2690902df2b6fae9bca1a6c13c3354d4"
BASE_TREE = "5b54078be8e447f7959359b10dfb393649ab9840"
EXPECTED_TREE = "5b7660a66d53da6a5935407bbaf21f7e73636f35"

def git(repo, *args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args], text=True).strip()

def verify(repo, expected_tree):
    if (git(repo, "rev-parse", "HEAD") != SHA
        or git(repo, "rev-parse", "HEAD^{tree}") != BASE_TREE
        or git(repo, "write-tree") != expected_tree
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others", "--exclude-standard")):
        raise SystemExit("RGB BFA build source does not match the exact admitted overlay")

def main():
    os.umask(0o077)
    args = sys.argv[1:]
    bare = bool(args and args[0] == "--bare")
    if bare:
        args.pop(0)
    if len(args) > 1:
        raise SystemExit("usage: prepare-source.py [--bare] [source]")
    dest = DEST.with_name("rgb-lib-bfa-bare") if bare else DEST
    patches = [PATCH]
    if bare:
        patches.append(ROOT / "patches" / "rgb-lib-bfa.5-embedded-lifecycle.patch")
    expected_tree = "8dd209a8bb849696e45f301b0ea1b3d4eb0fba06" if bare else EXPECTED_TREE
    if dest.exists():
        verify(dest, expected_tree)
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
    else:
        credentials += ["-c", "credential.helper=!gh auth git-credential"]
    with tempfile.TemporaryDirectory(dir=dest.parent) as work:
        staged = Path(work) / "candidate"
        staged.mkdir()
        git(staged, "init", "--quiet")
        git(staged, *credentials, "fetch", "--quiet", "--depth=1", "--no-tags", source, SHA)
        git(staged, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        for patch in patches:
            git(staged, "apply", "--check", "--index", str(patch))
            git(staged, "apply", "--index", str(patch))
        verify(staged, expected_tree)
        # A concurrently promoted directory is nonempty; rename then fails closed.
        staged.rename(dest)
    verify(dest, expected_tree)

if __name__ == "__main__":
    main()
