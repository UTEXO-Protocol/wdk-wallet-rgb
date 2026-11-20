#!/usr/bin/env python3
"""Collect exact dependency notices without changing or building dependencies.

Generation requires prepared native sources, cached Cargo dependencies and npm ci.
--check only verifies checked-in inventories/texts against the lockfiles; it does
not fetch sources, execute install hooks or regenerate from a different graph.
"""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "third-party-dependencies.json"
TEXTS = ROOT / "THIRD-PARTY-LICENSES.txt"
SUPPLEMENTS = ROOT / "scripts/notice-supplements.json"
INPUTS = ["package-lock.json", "native/Cargo.lock", "native/bare/Cargo.lock"]
NOTICE_NAME = re.compile(r"^(?:LICEN[CS]ES?|COPYING|NOTICE|COPYRIGHT)(?:[._-].*)?$", re.I)
EXCLUDED_DIRS = {".git", "node_modules", "target", "prebuilds"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def command(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def notice_files(root):
    result = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRS for part in relative.parts) or not path.is_file():
            continue
        if NOTICE_NAME.match(path.name) or "LICENSES" in relative.parts:
            result.append(path)
    return sorted(result)


def cargo_metadata(manifest):
    return json.loads(command([
        "cargo", "+1.94.0", "metadata", "--locked", "--offline",
        "--format-version", "1", "--manifest-path", manifest,
    ]))


def generate(npm_root=ROOT):
    supplements = read_json(SUPPLEMENTS)
    for supplement in supplements["licenses"].values():
        if sha256(supplement["text"].encode()) != supplement["sha256"]:
            raise ValueError("Supplement license text does not match its recorded hash")

    notices = {}
    packages = {}
    native_source = read_json(ROOT / "src/onchain-bare-native.json")["source"]
    rgb_root = ROOT / "native/.sources/rgb-lib-upstream"
    actual_rgb_head = command(["git", "rev-parse", "HEAD"], rgb_root)
    if actual_rgb_head != native_source:
        raise ValueError("Prepared RGB source does not match the native manifest")

    def record_text(package, raw, relative, origin):
        text = raw.decode("utf-8")
        digest = sha256(raw)
        notices.setdefault(digest, {"text": text, "uses": []})
        use = {"package": package["id"], "path": relative, "origin": origin}
        if use not in notices[digest]["uses"]:
            notices[digest]["uses"].append(use)
        ref = {"path": relative, "sha256": digest, "origin": origin}
        if ref not in package["notices"]:
            package["notices"].append(ref)

    def collect(package, root, source_root=None):
        files = notice_files(root)
        for path in files:
            record_text(package, path.read_bytes(), path.relative_to(root).as_posix(), "package")
        # Git workspaces often keep the shared license above the member crate.
        if source_root and source_root != root:
            parent = root.parent
            while parent == source_root or source_root in parent.parents:
                for path in sorted(parent.iterdir()):
                    if path.is_file() and NOTICE_NAME.match(path.name):
                        record_text(package, path.read_bytes(), path.relative_to(source_root).as_posix(), "workspace")
                if parent == source_root:
                    break
                parent = parent.parent
        if package["notices"]:
            package["noticeCoverage"] = "supplied-notices"
            return
        # Some published crates omit the license file. Keep that fact visible;
        # do not manufacture a package-specific copyright year or attribution.
        declared = package["license"]
        selected = next((name for name in ["Apache-2.0", "CC0-1.0", "MITNFA", "MIT"]
                         if name == declared or name in re.split(r"\s+OR\s+|/", declared)), None)
        if not selected:
            raise ValueError(f"No supplied or supported standard license text: {package['id']} ({declared})")
        item = supplements["licenses"][selected]
        record_text(package, item["text"].encode(), selected, item["url"])
        package["noticeCoverage"] = "standard-text-package-omits-license-file"
        package["standardLicenseText"] = selected

    for manifest, host in [("native/Cargo.toml", "node"), ("native/bare/Cargo.toml", "bare")]:
        metadata = cargo_metadata(manifest)
        for p in metadata["packages"]:
            if p["name"] in {"utexo-rgb-native", "utexo-rgb-native-bare"}:
                continue
            root = Path(p["manifest_path"]).parent
            source = p["source"]
            source_root = None
            if source is None and (root == rgb_root or rgb_root in root.parents):
                source = "git+https://github.com/UTEXO-Protocol/rgb-lib-bfa#" + native_source
                source_root = rgb_root
            elif source and source.startswith("git+"):
                source_root = Path(command(["git", "rev-parse", "--show-toplevel"], root))
            if not source or not p["license"]:
                raise ValueError(f"Missing exact source or declared license for {p['name']}")
            identifier = f"cargo:{p['name']}@{p['version']}:{source}"
            if identifier in packages:
                packages[identifier]["hosts"].append(host)
                continue
            package = {
                "id": identifier, "ecosystem": "cargo", "name": p["name"],
                "version": p["version"], "license": p["license"],
                "authors": p["authors"], "repository": p["repository"],
                "source": source, "hosts": [host], "notices": [],
            }
            if source.startswith("registry+"):
                package["sourceArchive"] = f"https://static.crates.io/crates/{p['name']}/{p['name']}-{p['version']}.crate"
            collect(package, root, source_root)
            packages[identifier] = package

    lock = read_json(ROOT / "package-lock.json")
    for path, p in lock["packages"].items():
        if not path or p.get("dev"):
            continue
        root = npm_root / path
        installed = read_json(root / "package.json")
        if installed["version"] != p["version"] or not p.get("license") or not p.get("integrity"):
            raise ValueError(f"Installed production dependency is not the locked package: {path}")
        name = installed["name"]
        identifier = f"npm:{name}@{p['version']}:{p['integrity']}"
        if identifier in packages:
            packages[identifier]["lockPaths"].append(path)
            continue
        repository = installed.get("repository")
        if isinstance(repository, dict):
            repository = repository.get("url")
        package = {
            "id": identifier, "ecosystem": "npm", "name": name,
            "version": p["version"], "license": p["license"],
            "author": installed.get("author"), "repository": repository,
            "source": p["resolved"], "integrity": p["integrity"],
            "lockPaths": [path], "notices": [],
        }
        collect(package, root)
        packages[identifier] = package

    sections = [
        "Third-party license and notice texts for @utexo/wdk-wallet-rgb\n",
        "Generated by scripts/generate-third-party-notices.py.\n",
        "See THIRD-PARTY-NOTICES.md and third-party-dependencies.json for scope,\n",
        "exact versions, original license expressions and source availability.\n",
        "Texts are deduplicated by their original UTF-8 byte SHA-256.\n\n",
    ]
    for digest, notice in sorted(notices.items()):
        sections.append(f"{'=' * 78}\nSHA-256: {digest}\n")
        for use in sorted(notice["uses"], key=lambda item: (item["package"], item["origin"], item["path"])):
            sections.append(f"{use['package']} | {use['origin']} | {use['path']}\n")
        sections.append("-" * 78 + "\n" + notice["text"] + "\n\n")
    text = "".join(sections).encode()
    data = {
        "formatVersion": 1,
        "scope": "Union of the locked Node/Bare Cargo resolve graphs (including build and target-conditional packages), plus npm production dependencies. This is an attribution inventory, not a claim every listed package is linked into every target.",
        "inputSha256": {path: sha256((ROOT / path).read_bytes()) for path in INPUTS},
        "rgbSource": native_source,
        "supplementSha256": sha256(SUPPLEMENTS.read_bytes()),
        "licenseTextsSha256": sha256(text),
        "packageCount": len(packages),
        "uniqueNoticeTextCount": len(notices),
        "packages": sorted(packages.values(), key=lambda p: p["id"]),
    }
    TEXTS.write_bytes(text)
    MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"Recorded {len(packages)} exact dependencies and {len(notices)} distinct notice texts")


def check():
    data = read_json(MANIFEST)
    if data["formatVersion"] != 1 or data["packageCount"] != len(data["packages"]):
        raise ValueError("Invalid dependency inventory")
    for path in INPUTS:
        if sha256((ROOT / path).read_bytes()) != data["inputSha256"][path]:
            raise ValueError(f"Regenerate notices after changing {path}")
    if sha256(SUPPLEMENTS.read_bytes()) != data["supplementSha256"]:
        raise ValueError("License supplements changed; regenerate notices")
    if sha256(TEXTS.read_bytes()) != data["licenseTextsSha256"]:
        raise ValueError("License texts do not match the inventory")
    if read_json(ROOT / "src/onchain-bare-native.json")["source"] != data["rgbSource"]:
        raise ValueError("Native RGB source changed; regenerate notices")
    identifiers = [package["id"] for package in data["packages"]]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Duplicate dependency identities")
    for package in data["packages"]:
        if not package["license"] or not package["notices"]:
            raise ValueError(f"Missing license or notice text: {package['id']}")
    print(f"Notice inventory matches both native locks and npm production lock ({len(identifiers)} dependencies)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--npm-root", type=Path, default=ROOT,
                        help="Directory containing npm ci --omit=dev --ignore-scripts for this lock")
    args = parser.parse_args()
    check() if args.check else generate(args.npm_root)
