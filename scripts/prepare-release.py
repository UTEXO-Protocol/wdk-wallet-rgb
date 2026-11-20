#!/usr/bin/env python3
"""Verify a complete SDK delivery set and optionally assemble local release assets.

This command never downloads, builds, publishes, tags or changes source files.
Reviewed Git objects anchor the artifact identities; local receipts are not trust
anchors. The supplied tarball must be packed from the current committed source.
"""

import argparse
import fnmatch
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BARE_TARGETS = (
    "android-arm", "android-arm64", "android-ia32", "android-x64",
    "darwin-arm64", "darwin-x64", "ios-arm64", "ios-arm64-simulator",
    "ios-x64-simulator", "linux-arm64", "linux-x64",
)
NODE_TARGETS = (
    "darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu", "linux-x64-musl",
)
NOTICE_FILES = ("THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt", "third-party-dependencies.json", "DEPENDENCY-POLICY.md")
MAX_FILE = 128 * 1024 * 1024
MAX_ARCHIVE = 2 * 1024 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_native_admission(native):
    require(native["releaseHold"] is False, "Native artifact admission is on hold")
    require(native.get("publicationHold") is not True, "This artifact is limited to qualification; publication is on hold")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def blob(commit, name):
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Expected an exact Git commit")
    return git("show", f"{commit}:{name}")


def committed_json(commit, name):
    return json.loads(blob(commit, name))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_identity(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return {"bytes": size, "sha256": digest.hexdigest()}


def regular_file(root, relative):
    name = PurePosixPath(relative)
    require(not name.is_absolute() and ".." not in name.parts, "Unsafe artifact path")
    current = root
    require(current.is_dir() and not current.is_symlink(), "Artifact root must be a real directory")
    for part in name.parts:
        current = current / part
        require(not current.is_symlink(), f"Symlink is not an artifact: {relative}")
    require(current.is_file(), f"Missing regular artifact: {relative}")
    return current


def verify_identity(path, expected):
    actual = file_identity(path)
    require(actual == {key: expected[key] for key in ("bytes", "sha256")}, f"Artifact identity mismatch: {path.name}")
    return actual


def verify_source(producer, head):
    git("merge-base", "--is-ancestor", producer, head)
    changed = git("diff", "--name-only", producer, head, "--", "native", "src/onchain-dev-services.json", ".github/workflows/build.yml").decode().splitlines()
    changed = [name for name in changed if not name.endswith(".md")]
    require(not changed, "Native build inputs changed since the reviewed producer: " + ", ".join(changed))
    old = committed_json(producer, "package.json")
    new = committed_json(head, "package.json")
    # Mobile library names include the SDK version. A version change needs newly
    # admitted artifacts, even if the Rust engine itself did not change.
    require(old["version"] == new["version"], "SDK version differs from native producer")
    runtime_changed = git("diff", "--name-only", producer, head, "--", "src", "onchain.js", "onchain.d.ts", "webrgb-onchain.d.ts").decode().splitlines()
    runtime_changed = [path for path in runtime_changed if path != "src/onchain-bare-native.json"]
    runtime_package_fields = ("dependencies", "engines", "exports", "imports", "main")
    if any(old.get(key) != new.get(key) for key in runtime_package_fields):
        runtime_changed.append("package.json")
    return {"producerCommit": producer, "releaseCommit": head, "nativeInputsUnchanged": True,
            "runtimeFilesUnchangedSinceProducer": not runtime_changed,
            "runtimeFilesChangedSinceProducer": runtime_changed,
            "fundedRuntimeEquivalence": "Not evaluated by this artifact verifier; use the separate funded qualification receipt."}


def verify_platforms(evidence, artifacts, version, native):
    expected = {"bare-" + name for name in BARE_TARGETS} | {"node-" + name for name in NODE_TARGETS}
    require(set(evidence["platforms"]) == expected and evidence["count"] == 16, "Incomplete native target matrix")
    require(evidence["packageVersion"] == version, "Platform evidence has a different package version")
    require(set(native["targets"]) == set(BARE_TARGETS), "Incomplete packed Bare target admission")
    results = {}
    for name, reviewed in sorted(evidence["platforms"].items()):
        require(reviewed["sourceCommit"] == evidence["producerCommit"], "Mixed native producer commits")
        require(reviewed["receiptMatchedBinary"] is True, "Artifact lacks reviewed receipt admission")
        binary_name = "utexo-rgb-native" if name.startswith("node-") else "utexo__wdk-wallet-rgb.bare"
        require(reviewed["binaryFile"] == binary_name, "Unexpected native binary filename")
        binary = regular_file(artifacts, f"{name}/{binary_name}")
        identity = verify_identity(binary, reviewed)
        results[name] = {**identity, "producerCommit": reviewed["sourceCommit"],
                         "nativeRuntimeExecuted": reviewed["nativeRuntimeExecuted"],
                         "artifactUrl": reviewed["artifactUrl"]}
        if name.startswith("node-"):
            abi = reviewed.get("abi")
            require(isinstance(abi, dict) and abi.get("format") in ("Mach-O", "ELF"), "Missing reviewed Node ABI requirements")
            results[name]["abi"] = abi
        elif "abi" in reviewed:
            results[name]["abi"] = reviewed["abi"]
    for name in BARE_TARGETS:
        admitted = evidence["packedBareTargets"][name]
        require(admitted["pin"] == native["targets"][name], "Packed Bare pin differs from reviewed qualification")
        require(admitted["producerCommit"] == evidence["producerCommit"], "Packed Bare producer differs")
        pin = admitted["pin"]
        linked = None
        if name.startswith("android-"):
            linked = f"libutexo__wdk-wallet-rgb.{version}.so"
        elif name.startswith("ios-"):
            stem = f"utexo__wdk-wallet-rgb.{version}"
            linked = f"{stem}.framework/{stem}"
        require(set(pin) == ({"sha256", "byteLength", "linkedName"} if linked else {"sha256", "byteLength"}), "Unexpected Bare pin fields")
        require(pin.get("linkedName") == linked, "Mobile linked name differs from SDK version")
        require(re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]) and 0 < pin["byteLength"] <= MAX_FILE, "Invalid Bare pin")
    return results


def verify_pack(archive, head, package, native):
    require(archive.is_file() and not archive.is_symlink(), "Package archive must be a regular file")
    require(archive.stat().st_size <= MAX_ARCHIVE, "Package archive is oversized")
    tracked = set(git("ls-tree", "-r", "--name-only", head).decode().splitlines())
    expected = {"package.json", "README.md", "LICENSE"}
    for path in tracked:
        if any(fnmatch.fnmatchcase(path, pattern) or path.startswith(pattern.rstrip("/") + "/") for pattern in package["files"]):
            expected.add(path)
    expected |= {f"prebuilds/{target}/utexo__wdk-wallet-rgb.bare" for target in BARE_TARGETS}
    inventory = {}
    total = 0
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            require(member.isfile(), "Package contains a link, directory or special entry")
            require(member.name.startswith("package/"), "Package member has a foreign prefix")
            path = member.name[len("package/"):]
            require(path in expected and path not in inventory, "Unexpected or duplicate package member: " + path)
            require(0 <= member.size <= MAX_FILE, "Oversized package member")
            total += member.size
            require(total <= MAX_ARCHIVE, "Unpacked package is oversized")
            with stream.extractfile(member) as source:
                data = source.read()
            require(len(data) == member.size, "Truncated package member")
            if path.startswith("prebuilds/"):
                target = path.split("/")[1]
                pin = native["targets"][target]
                require(len(data) == pin["byteLength"] and sha256(data) == pin["sha256"], "Packed addon identity mismatch: " + target)
            else:
                require(data == blob(head, path), "Package differs from committed source: " + path)
            inventory[path] = {"bytes": len(data), "sha256": sha256(data)}
    require(set(inventory) == expected, "Missing package members: " + ", ".join(sorted(expected - set(inventory))))
    return {"filename": archive.name, **file_identity(archive), "files": inventory}


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def deterministic_tar(destination, entries):
    with destination.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for name, data, executable in sorted(entries):
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o755 if executable else 0o644
                    member.mtime = 0
                    archive.addfile(member, io.BytesIO(data))


def assemble(output, archive, artifacts, evidence, report, head):
    require(not output.exists() and not output.is_symlink(), "Output already exists")
    require(output.parent.is_dir(), "Create the output parent directory first")
    # Stage beside the destination and rename only after every asset is complete.
    staging = Path(tempfile.mkdtemp(prefix=".wdk-release-", dir=output.parent))
    try:
        notices = [(name, blob(head, name), False) for name in NOTICE_FILES]
        require(all(name in report["package"]["files"] for name in NOTICE_FILES), "Package does not include complete third-party notices")
        shutil.copyfile(archive, staging / archive.name)
        verify_identity(staging / archive.name, report["package"])
        assets = {archive.name: file_identity(staging / archive.name)}
        nodes = {}
        for target in NODE_TARGETS:
            key = "node-" + target
            binary = regular_file(artifacts, key + "/utexo-rgb-native")
            # Recheck bytes immediately before writing to catch changed inputs.
            verify_identity(binary, evidence["platforms"][key])
            data = binary.read_bytes()
            reviewed = evidence["platforms"][key]
            require(sha256(data) == reviewed["sha256"], "Node worker changed while reading")
            name = f"utexo-wdk-wallet-rgb-{report['packageVersion']}-node-{target}.tar.gz"
            receipt = {"target": target, "packageVersion": report["packageVersion"],
                       "source": report["source"], "binary": report["platforms"][key]}
            readme = (
                f"Node worker for @utexo/wdk-wallet-rgb {report['packageVersion']} ({target})\n\n"
                "Install the matching SDK package separately. Extract this archive into an application-owned directory.\n"
                "Pass the absolute path of utexo-rgb-native as nativeExecutable and this SHA-256 as nativeSha256:\n"
                f"{reviewed['sha256']}\n\n"
                "ABI requirements are recorded in release-receipt.json under binary.abi.\n"
                "For GNU/Linux, the host must provide every recorded GLIBC symbol version; ARM64 and x64 have different minimums.\n"
                "Use the separate musl worker on musl systems. macOS must satisfy minimumOS as well as the Node runtime requirement.\n\n"
                "The SDK verifies the hash and protocol before opening the wallet. Do not select an executable via PATH.\n"
                "Keep this file and the third-party notices with redistributed copies. No install scripts or downloads run.\n"
            ).encode()
            deterministic_tar(staging / name, [
                ("utexo-rgb-native", data, True), ("release-receipt.json", json_bytes(receipt), False),
                ("README.txt", readme, False), ("LICENSE", blob(head, "LICENSE"), False), *notices,
            ])
            assets[name] = file_identity(staging / name)
            nodes[target] = {"archive": name, "nativeExecutable": "utexo-rgb-native", "nativeSha256": reviewed["sha256"]}
        result = {**report, "assets": assets, "nodeWorkers": nodes, "published": False}
        manifest = staging / "release-manifest.json"
        manifest.write_bytes(json_bytes(result))
        sums = {**assets, manifest.name: file_identity(manifest)}
        (staging / "SHA256SUMS").write_text("".join(f"{entry['sha256']}  {name}\n" for name, entry in sorted(sums.items())))
        staging.rename(output)
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True, help="Verified CI artifact directories, named node-<target> and bare-<target>")
    parser.add_argument("--qualification", required=True, help="Committed platform receipt path, for example qualification/rc1/platforms.json")
    parser.add_argument("--output", type=Path, help="New output directory for the complete local release set")
    args = parser.parse_args()
    require(not git("status", "--porcelain", "--untracked-files=normal").strip(), "Commit source changes before recording release evidence")
    head = git("rev-parse", "HEAD").decode().strip()
    package = committed_json(head, "package.json")
    require(package["name"] == "@utexo/wdk-wallet-rgb", "Wrong package name")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", package["version"]), "Unexpected package version")
    native = committed_json(head, "src/onchain-bare-native.json")
    verify_native_admission(native)
    require(native["overlayTree"] == native["integrationTree"], "Source overlays are not admitted for this release")
    evidence = committed_json(head, args.qualification)
    source = verify_source(evidence["producerCommit"], head)
    platforms = verify_platforms(evidence, args.artifacts, package["version"], native)
    pack = verify_pack(args.archive, head, package, native)
    report = {"schemaVersion": 1, "packageVersion": package["version"], "source": source,
              "native": {key: native[key] for key in ("source", "overlayTree", "integrationTree", "protocol")},
              "platforms": platforms, "package": pack,
              "scope": "Artifact identity and source equivalence; not additional mobile, funded or hosted runtime acceptance."}
    if args.output:
        report = assemble(args.output, args.archive, args.artifacts, evidence, report, head)
    print(json_bytes(report).decode(), end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(f"Release preparation failed: {error}") from error
