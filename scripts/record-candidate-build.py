#!/usr/bin/env python3
"""Inventory the exact qualification artifacts and their locked build inputs."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def stream_sha256(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def sha256(path):
    with path.open("rb") as stream:
        return stream_sha256(stream)


def cargo_inventory(manifest, platform):
    metadata = json.loads(command(
        "cargo", "+1.94.0", "metadata", "--format-version=1", "--locked", "--offline",
        "--filter-platform", platform, "--manifest-path", manifest,
    ))
    rows = []
    for crate in metadata["packages"]:
        if not (crate["license"] or crate["license_file"]):
            raise SystemExit(f"Missing license metadata for {crate['name']} {crate['version']}")
        crate_root = Path(crate["manifest_path"]).parent
        notices = {
            path.name: sha256(path) for path in sorted(crate_root.iterdir())
            if path.is_file() and path.name.upper().startswith(("LICENSE", "LICENCE", "NOTICE", "COPYING"))
        }
        if crate["license_file"]:
            notice = crate_root / crate["license_file"]
            notices[crate["license_file"]] = sha256(notice)
        rows.append({
            "name": crate["name"], "version": crate["version"], "license": crate["license"],
            "source": crate["source"] or str(crate_root.relative_to(ROOT)), "noticeDigests": notices,
        })
    return sorted(rows, key=lambda row: (row["name"], row["version"], row["source"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for role in ("worker", "addon", "tarball", "apk"):
        parser.add_argument(f"--{role}", type=Path, required=True)
    args = parser.parse_args()
    if command("git", "status", "--porcelain", "--untracked-files=normal"):
        raise SystemExit("Record evidence from a clean committed source tree")
    command("python3", "native/scripts/prepare-source.py", "--bare")
    artifacts = {
        role: {"filename": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}
        for role, path in vars(args).items()
    }
    manifest = json.loads((ROOT / "src/onchain-bare-native.json").read_text())
    if (manifest["sha256"], manifest["byteLength"]) != (artifacts["addon"]["sha256"], artifacts["addon"]["bytes"]):
        raise SystemExit("Addon does not match the committed package manifest")
    expected = artifacts["addon"]["sha256"]
    with tarfile.open(args.tarball, "r:gz") as tar:
        with tar.extractfile("package/prebuilds/android-arm64/utexo__wdk-wallet-rgb.bare") as addon:
            if stream_sha256(addon) != expected:
                raise SystemExit("Packed addon does not match the admitted build")
    with zipfile.ZipFile(args.apk) as apk:
        with apk.open("lib/arm64-v8a/" + manifest["linkedName"]) as addon:
            if stream_sha256(addon) != expected:
                raise SystemExit("APK addon does not match the admitted build")
    npm = []
    for location, pkg in json.loads((ROOT / "package-lock.json").read_text())["packages"].items():
        if not location or pkg.get("dev", False):
            continue
        if not all(pkg.get(key) for key in ("version", "license", "integrity")):
            raise SystemExit(f"Missing npm source or license metadata for {location}")
        npm.append({"location": location, **{key: pkg[key] for key in ("version", "license", "integrity")}})
    inputs = (
        "package-lock.json", "native/Cargo.lock", "native/bare/Cargo.lock", "native/bare/package-lock.json",
        "native/scripts/prepare-source.py",
        *(str(path.relative_to(ROOT)) for path in sorted((ROOT / "native/patches").glob("*.patch"))),
    )
    evidence = {
        "commit": command("git", "rev-parse", "HEAD"),
        "sourceTree": command("git", "rev-parse", "HEAD^{tree}"),
        "rustc": command("rustc", "+1.94.0", "-vV"),
        "node": command("node", "--version"), "npm": command("npm", "--version"),
        "inputDigests": {name: sha256(ROOT / name) for name in inputs}, "artifacts": artifacts,
        "nativeIntegrationTree": manifest["integrationTree"],
        "npmRuntime": npm,
        "cargoNodeDarwinArm64": cargo_inventory("native/Cargo.toml", "aarch64-apple-darwin"),
        "cargoBareAndroidArm64": cargo_inventory("native/bare/Cargo.toml", "aarch64-linux-android"),
    }
    print(json.dumps(evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
