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
import importlib.util
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


def verify_native_admission(native, *, qualification_only=False):
    require(native["releaseHold"] is False, "Native artifact admission is on hold")
    require(qualification_only or native.get("publicationHold") is not True,
            "This artifact is limited to qualification; publication is on hold")


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


def verify_source(producer, head, runtime=None):
    git("merge-base", "--is-ancestor", producer, head)
    changed = git("diff", "--name-only", producer, head, "--", "native", "src/onchain-dev-services.json", ".github/workflows/build.yml").decode().splitlines()
    changed = [name for name in changed if not name.endswith(".md")]
    if runtime == "bare":
        if ".github/workflows/build.yml" in changed:
            spec = importlib.util.spec_from_file_location("native_scope", Path(__file__).with_name("native-build-scope.py"))
            scope = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(scope)
            require(scope.bare_workflow_inputs(blob(producer, ".github/workflows/build.yml").decode()) ==
                    scope.bare_workflow_inputs(blob(head, ".github/workflows/build.yml").decode()),
                    "Bare workflow build inputs changed since the reviewed producer")
        # The retained Bare artifact has its original CI receipt. Node host code
        # and its Cargo manifest are not build inputs to native/bare/Cargo.toml.
        # Never exempt shared native/src modules or the Bare dependency lock.
        changed = [name for name in changed if not (
            name.startswith("native/node/") or name in (
                "native/Cargo.toml", "native/Cargo.lock", "native/src/main.rs",
                "native/scripts/check-dev-signet.py", "native/scripts/node-host.mjs", ".github/workflows/build.yml"))]
    elif runtime == "node":
        changed = [name for name in changed if not (
            name.startswith("native/bare/") or name in (
                "native/scripts/build-bare.sh", "native/scripts/build-bare-android.sh",
                "native/scripts/build-bare-ios.sh", "native/scripts/verify-bare-android.mjs"))]
    elif runtime is not None:
        raise ValueError("Unknown native runtime")
    require(not changed, "Native build inputs changed since the reviewed producer: " + ", ".join(changed))
    old = committed_json(producer, "package.json")
    new = committed_json(head, "package.json")
    # Mobile library names include the SDK version. A version change needs newly
    # admitted artifacts, even if the Rust engine itself did not change.
    require(old["version"] == new["version"], "SDK version differs from native producer")
    runtime_changed = git("diff", "--name-only", producer, head, "--", "src", "onchain.js", "onchain.d.ts", "webrgb-onchain.d.ts").decode().splitlines()
    runtime_changed = [path for path in runtime_changed if path not in ("src/onchain-bare-native.json", "src/onchain-node-native.json")]
    runtime_package_fields = ("dependencies", "engines", "exports", "imports", "main")
    if any(old.get(key) != new.get(key) for key in runtime_package_fields):
        runtime_changed.append("package.json")
    return {"producerCommit": producer, "releaseCommit": head, "nativeInputsUnchanged": True,
            "runtimeFilesUnchangedSinceProducer": not runtime_changed,
            "runtimeFilesChangedSinceProducer": runtime_changed,
            "fundedRuntimeEquivalence": "Not evaluated by this artifact verifier; use the separate funded qualification receipt."}


def verify_platforms(evidence, artifacts, version, native, node_native):
    expected = {"bare-" + name for name in BARE_TARGETS} | {"node-" + name for name in NODE_TARGETS}
    require(set(evidence["platforms"]) == expected and evidence["count"] == 16, "Incomplete native target matrix")
    require(evidence["packageVersion"] == version, "Platform evidence has a different package version")
    require(set(native["targets"]) == set(BARE_TARGETS), "Incomplete packed Bare target admission")
    require(set(node_native["targets"]) == set(NODE_TARGETS), "Incomplete packed Node target admission")
    results = {}
    for name, reviewed in sorted(evidence["platforms"].items()):
        runtime = name.split("-", 1)[0]
        producer = evidence.get("producers", {}).get(runtime, evidence.get("producerCommit"))
        require(reviewed["sourceCommit"] == producer, "Unreviewed native producer commit")
        require(reviewed["receiptMatchedBinary"] is True, "Artifact lacks reviewed receipt admission")
        binary_name = "utexo-rgb-native.node" if name.startswith("node-") else "utexo__wdk-wallet-rgb.bare"
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
        require(admitted["producerCommit"] == evidence.get("producers", {}).get("bare", evidence.get("producerCommit")), "Packed Bare producer differs")
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
        binary = results["bare-" + name]
        require(pin["sha256"] == binary["sha256"] and pin["byteLength"] == binary["bytes"],
                "Packed Bare pin differs from binary")
    for name in NODE_TARGETS:
        admitted = evidence["packedNodeTargets"][name]
        require(admitted["pin"] == node_native["targets"][name], "Packed Node pin differs from reviewed qualification")
        require(admitted["producerCommit"] == evidence.get("producers", {}).get("node", evidence.get("producerCommit")), "Packed Node producer differs")
        pin = admitted["pin"]
        require(set(pin) == {"sha256", "byteLength"}, "Unexpected Node pin fields")
        require(re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]) and 0 < pin["byteLength"] <= MAX_FILE, "Invalid Node pin")
        binary = results["node-" + name]
        require(pin == {"sha256": binary["sha256"], "byteLength": binary["bytes"]}, "Packed Node pin differs from binary")
    return results


def verify_pack(archive, head, package, native, node_native):
    require(archive.is_file() and not archive.is_symlink(), "Package archive must be a regular file")
    require(archive.stat().st_size <= MAX_ARCHIVE, "Package archive is oversized")
    tracked = set(git("ls-tree", "-r", "--name-only", head).decode().splitlines())
    expected = {"package.json", "README.md", "LICENSE"}
    for path in tracked:
        if any(fnmatch.fnmatchcase(path, pattern) or path.startswith(pattern.rstrip("/") + "/") for pattern in package["files"]):
            expected.add(path)
    expected |= {f"prebuilds/{target}/utexo__wdk-wallet-rgb.bare" for target in BARE_TARGETS}
    expected |= {f"prebuilds/{target}/utexo-rgb-native.node" for target in NODE_TARGETS}
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
                pin = (node_native if path.endswith(".node") else native)["targets"][target]
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
        # All runtimes are present in the same verified npm archive. Separate
        # executable downloads are no longer part of the delivery contract.
        result = {**report, "assets": assets, "published": False}
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
    parser.add_argument("--qualification", required=True, help="Repository-relative committed platform receipt path, for example qualification/rc4/platforms.json")
    parser.add_argument("--output", type=Path, help="New output directory for the complete local release set")
    parser.add_argument("--verify-qualification", action="store_true",
                        help="Verify all artifacts while publication remains on hold; cannot be combined with --output")
    args = parser.parse_args()
    require(not (args.verify_qualification and args.output),
            "Qualification verification cannot assemble release assets; omit --output")
    require(not git("status", "--porcelain", "--untracked-files=normal").strip(), "Commit source changes before recording release evidence")
    head = git("rev-parse", "HEAD").decode().strip()
    package = committed_json(head, "package.json")
    require(package["name"] == "@utexo/wdk-wallet-rgb", "Wrong package name")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", package["version"]), "Unexpected package version")
    native = committed_json(head, "src/onchain-bare-native.json")
    node_native = committed_json(head, "src/onchain-node-native.json")
    verify_native_admission(native, qualification_only=args.verify_qualification)
    verify_native_admission(node_native, qualification_only=args.verify_qualification)
    require(all(node_native[key] == native[key] for key in ("source", "overlayTree", "integrationTree", "protocol")), "Node and Bare RGB identities differ")
    require(node_native.get("nodeApiVersion") == 8 and node_native.get("runtime") == "node-in-process", "Unexpected Node addon ABI")
    require(native["overlayTree"] == native["integrationTree"], "Source overlays are not admitted for this release")
    evidence = committed_json(head, args.qualification)
    producers = evidence.get("producers", {"bare": evidence.get("producerCommit"), "node": evidence.get("producerCommit")})
    require(set(producers) == {"bare", "node"}, "Missing runtime producer identity")
    source = {runtime: verify_source(producer, head, runtime) for runtime, producer in producers.items()}
    platforms = verify_platforms(evidence, args.artifacts, package["version"], native, node_native)
    pack = verify_pack(args.archive, head, package, native, node_native)
    report = {"schemaVersion": 1, "packageVersion": package["version"], "source": source,
              "native": {key: native[key] for key in ("source", "overlayTree", "integrationTree", "protocol")},
              "platforms": platforms, "package": pack,
              "scope": "Artifact identity and source equivalence; not additional mobile, funded or hosted runtime acceptance."}
    if args.verify_qualification:
        report.update({
            "qualificationOnly": True,
            "publicationAllowed": False,
            "holds": {"releaseHold": native["releaseHold"],
                      "publicationHold": native.get("publicationHold") is True or node_native.get("publicationHold") is True},
            "publicationBlockers": ["Qualification verification cannot assemble or authorize a release."] +
                (["The committed native manifest retains its publication hold."]
                 if native.get("publicationHold") is True or node_native.get("publicationHold") is True else []),
        })
    if args.output:
        report = assemble(args.output, args.archive, args.artifacts, evidence, report, head)
    print(json_bytes(report).decode(), end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit(f"Release preparation failed: {error}") from error
