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
PATCHES = ROOT / "patches"
SHA = "9ec49c08be2e68f08521281e3efbd760ec989cb9"
BASE_TREE = "a4f8ad11dd975d357f9d2c6baab0d45205416986"
EXPECTED_TREE = "b37467c8d774acd5153094cbd62165b8acdf6be8"
ESPLORA_PACKAGE = "esplora-client-0.12.3"
ESPLORA_SHA256 = "f19e3ea99dbfbef0c1ec26d83e69de0c579f6aa6aaac4f44597805fcc27e97af"
ESPLORA_EXPECTED_TREE = "0b02f9ababbb4f276dcea5168fc8cf59914c6744"
ESPLORA_PATCH = PATCHES / "esplora-client-0.12.3-guarded-blocking.patch"
ELECTRUM_PACKAGE = "electrum-client-0.25.2"
ELECTRUM_SHA256 = "19701e9c0ce6e3337eb31bd307b854e762c6ffa2ccd19167ebd3588ec53e4447"
ELECTRUM_EXPECTED_TREE = "095a4e8981c400a9dc3625d7617937397d5bce3c"
ELECTRUM_PATCH = PATCHES / "electrum-client-0.25.2-checked-reconnect.patch"

def git(repo, *args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(repo), *args], text=True).strip()

def verify(repo, expected_tree):
    if (git(repo, "rev-parse", "HEAD") != SHA
        or git(repo, "rev-parse", "HEAD^{tree}") != BASE_TREE
        or git(repo, "write-tree") != expected_tree
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others", "--exclude-standard")):
        raise SystemExit("RGB BFA build source does not match the exact admitted overlay")

def prepare_crate(name, package_name, sha256, patch, tree):
    dest = DEST.with_name(name)
    if not dest.exists():
        dest.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent) as work:
            cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
            cached = next((cargo_home / "registry" / "cache").glob(f"*/{package_name}.crate"), None)
            if cached is not None:
                package = cached.read_bytes()
            else:
                url = f"https://static.crates.io/crates/{name}/{package_name}.crate"
                with urllib.request.urlopen(url, timeout=30) as response:
                    package = response.read(512 * 1024 + 1)
            if hashlib.sha256(package).hexdigest() != sha256:
                raise SystemExit(f"{package_name} crate does not match its pinned SHA-256")
            with tarfile.open(fileobj=io.BytesIO(package), mode="r:gz") as archive:
                members = archive.getmembers()
                for member in members:
                    parts = Path(member.name).parts
                    if (not parts or parts[0] != package_name
                        or ".." in parts or ".git" in parts
                        or not (member.isfile() or member.isdir())):
                        raise SystemExit(f"Unexpected path or entry in the {package_name} crate")
                archive.extractall(work, members=members)
            staged = Path(work) / package_name
            git(staged, "init", "--quiet")
            git(staged, "add", "--force", "--all")
            git(staged, "apply", "--index", str(patch))
            verify_crate(staged, tree)
            staged.rename(dest)
    verify_crate(dest, tree)

def verify_crate(repo, tree):
    if (git(repo, "write-tree") != tree
        or git(repo, "diff", "--name-only")
        or git(repo, "ls-files", "--others")):
        raise SystemExit(f"{repo.name} source does not match the exact admitted overlay")

def main():
    os.umask(0o077)
    args = sys.argv[1:]
    bare = bool(args and args[0] == "--bare")
    if bare:
        args.pop(0)
    if len(args) > 1:
        raise SystemExit("usage: prepare-source.py [--bare] [source]")
    prepare_crate("esplora-client", ESPLORA_PACKAGE, ESPLORA_SHA256, ESPLORA_PATCH,
                  ESPLORA_EXPECTED_TREE)
    prepare_crate("electrum-client", ELECTRUM_PACKAGE, ELECTRUM_SHA256, ELECTRUM_PATCH,
                  ELECTRUM_EXPECTED_TREE)
    dest = DEST.with_name("rgb-lib-bfa-bare") if bare else DEST
    patches = [
        PATCHES / "rgb-lib-bfa.7-registration.patch",
        PATCHES / "rgb-lib-bfa.7-native-egress.patch",
        PATCHES / "rgb-lib-bfa.7-signet-checkpoint.patch",
        PATCHES / "rgb-lib-bfa.7-proxy-deadline.patch",
        PATCHES / "rgb-lib-bfa.7-verified-colored-outputs.patch",
        PATCHES / "rgb-lib-bfa.7-public-chain-admission.patch",
        PATCHES / "rgb-lib-bfa.7-bound-proxy.patch",
        PATCHES / "rgb-lib-bfa.7-electrum-reconnect.patch",
    ]
    if bare:
        patches.append(PATCHES / "rgb-lib-bfa.7-embedded-lifecycle.patch")
    expected_tree = "e6577e6646535d60b575f60494b42997cc50e8e3" if bare else EXPECTED_TREE
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
