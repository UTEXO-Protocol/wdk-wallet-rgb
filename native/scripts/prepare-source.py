#!/usr/bin/env python3
"""Prepare and verify the private build source. Never used at consumer install."""
from pathlib import Path
import hashlib
import io
import os
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / ".sources" / "rgb-lib-bfa"
SOURCE_URL = "https://github.com/UTEXO-Protocol/rgb-lib-bfa.git"
PATCH = ROOT / "patches" / "rgb-lib-bfa.5-onchain.patch"
SHA = "0a9d352f2690902df2b6fae9bca1a6c13c3354d4"
BASE_TREE = "5b54078be8e447f7959359b10dfb393649ab9840"
EXPECTED_TREE = "e517dc80f613bee86a9808e8a54c361e4be73810"
ESPLORA_PACKAGE = "esplora-client-0.12.3"
ESPLORA_SHA256 = "f19e3ea99dbfbef0c1ec26d83e69de0c579f6aa6aaac4f44597805fcc27e97af"
ESPLORA_EXPECTED_TREE = "0b02f9ababbb4f276dcea5168fc8cf59914c6744"
ESPLORA_PATCH = ROOT / "patches" / "esplora-client-0.12.3-guarded-blocking.patch"

def git(repo, *args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args], text=True).strip()

def verify(repo, expected_tree):
    if (git(repo, "rev-parse", "HEAD") != SHA
        or git(repo, "rev-parse", "HEAD^{tree}") != BASE_TREE
        or git(repo, "write-tree") != expected_tree
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others", "--exclude-standard")):
        raise SystemExit("RGB BFA build source does not match the exact admitted overlay")

def prepare_esplora():
    dest = DEST.with_name("esplora-client")
    if not dest.exists():
        dest.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent) as work:
            cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
            cached = next((cargo_home / "registry" / "cache").glob(f"*/{ESPLORA_PACKAGE}.crate"), None)
            if cached is not None:
                package = cached.read_bytes()
            else:
                url = f"https://static.crates.io/crates/esplora-client/{ESPLORA_PACKAGE}.crate"
                with urllib.request.urlopen(url, timeout=30) as response:
                    package = response.read(128 * 1024)
            if hashlib.sha256(package).hexdigest() != ESPLORA_SHA256:
                raise SystemExit("Esplora client crate does not match its pinned SHA-256")
            with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
                members = archive.getmembers()
                for member in members:
                    parts = Path(member.name).parts
                    if (not parts or parts[0] != ESPLORA_PACKAGE
                        or ".." in parts or ".git" in parts
                        or not (member.isfile() or member.isdir())):
                        raise SystemExit("Unexpected path or entry in the Esplora client crate")
                archive.extractall(work, members=members)
            staged = Path(work) / ESPLORA_PACKAGE
            git(staged, "init", "--quiet")
            git(staged, "add", "--force", "--all")
            git(staged, "apply", "--index", str(ESPLORA_PATCH))
            verify_esplora(staged)
            staged.rename(dest)
    verify_esplora(dest)

def verify_esplora(repo):
    if (git(repo, "write-tree") != ESPLORA_EXPECTED_TREE
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others")):
        raise SystemExit("Esplora client source does not match the exact admitted overlay")

def main():
    os.umask(0o077)
    args = sys.argv[1:]
    bare = bool(args and args[0] == "--bare")
    if bare:
        args.pop(0)
    if len(args) > 1:
        raise SystemExit("usage: prepare-source.py [--bare] [source]")
    prepare_esplora()
    dest = DEST.with_name("rgb-lib-bfa-bare") if bare else DEST
    patches = [PATCH]
    if bare:
        patches.append(ROOT / "patches" / "rgb-lib-bfa.5-embedded-lifecycle.patch")
    patches += [
        ROOT / "patches" / "rgb-lib-bfa.5-public-signet.patch",
        ROOT / "patches" / "rgb-lib-bfa.5-native-egress.patch",
        ROOT / "patches" / "rgb-lib-bfa.5-staging-evm-egress.patch",
        ROOT / "patches" / "rgb-lib-bfa.5-dev-signet.patch",
    ]
    expected_tree = "8a113320471c79b046c7ea045ccc9b20f4484be6" if bare else EXPECTED_TREE
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
