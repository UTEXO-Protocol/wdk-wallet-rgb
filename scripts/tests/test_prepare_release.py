"""Failure-oriented checks for release artifact admission, without native builds."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "prepare-release.py"
SPEC = importlib.util.spec_from_file_location("prepare_release", SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleasePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.old_root = release.ROOT
        release.ROOT = self.repo
        self.git("init", "-q")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "test@example.invalid")
        self.package = {"name": "@utexo/wdk-wallet-rgb", "version": "3.0.0-rc.1", "files": ["onchain.js", *release.NOTICE_FILES]}
        self.write("package.json", json.dumps(self.package).encode())
        self.write("README.md", b"SDK documentation\n")
        self.write("LICENSE", b"License fixture\n")
        self.write("onchain.js", b"export default 1\n")
        self.write("native/src/main.rs", b"fn main() {}\n")
        self.write("native/Cargo.lock", b"locked source\n")
        self.write("native/README.md", b"Build documentation\n")
        for name in release.NOTICE_FILES:
            self.write(name, b"Notice fixture\n")
        self.producer = self.commit()
        self.head = self.producer
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.native = {"targets": {}}
        self.evidence = {"packageVersion": self.package["version"], "producerCommit": self.producer,
                         "count": 16, "platforms": {}, "packedBareTargets": {}}
        self.entries = []
        for target in release.BARE_TARGETS:
            self.add_binary("bare-" + target, "utexo__wdk-wallet-rgb.bare")
            data = ("bare-" + target).encode()
            pin = {"sha256": release.sha256(data), "byteLength": len(data)}
            if target.startswith("android-"):
                pin["linkedName"] = "libutexo__wdk-wallet-rgb.3.0.0-rc.1.so"
            elif target.startswith("ios-"):
                pin["linkedName"] = "utexo__wdk-wallet-rgb.3.0.0-rc.1.framework/utexo__wdk-wallet-rgb.3.0.0-rc.1"
            self.native["targets"][target] = pin
            self.evidence["packedBareTargets"][target] = {"pin": pin, "producerCommit": self.producer}
            self.entries.append(("package/prebuilds/" + target + "/utexo__wdk-wallet-rgb.bare", data, False))
        for target in release.NODE_TARGETS:
            self.add_binary("node-" + target, "utexo-rgb-native")
        for name in ["package.json", "README.md", "LICENSE", "onchain.js", *release.NOTICE_FILES]:
            self.entries.append(("package/" + name, (self.repo / name).read_bytes(), False))
        self.archive = self.root / "sdk.tgz"
        release.deterministic_tar(self.archive, self.entries)

    def tearDown(self):
        release.ROOT = self.old_root
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, data):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def add_binary(self, name, filename):
        folder = self.artifacts / name
        folder.mkdir()
        data = name.encode()
        (folder / filename).write_bytes(data)
        self.evidence["platforms"][name] = {
            "bytes": len(data), "sha256": release.sha256(data), "sourceCommit": self.producer,
            "receiptMatchedBinary": True, "nativeRuntimeExecuted": name.startswith("node-"),
            "binaryFile": filename, "artifactUrl": "https://example.invalid/artifact",
        }
        if name.startswith("node-"):
            self.evidence["platforms"][name]["abi"] = ({"format": "Mach-O", "minimumOS": "11.0"}
                if "darwin" in name else {"format": "ELF", "glibcVersions": ["2.17", "2.34"]})

    def verify_pack(self):
        return release.verify_pack(self.archive, self.head, self.package, self.native)

    def test_complete_set_and_pack_are_admitted(self):
        self.assertEqual(len(release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)), 16)
        self.assertEqual(len(self.verify_pack()["files"]), len(self.entries))
        self.assertTrue(release.verify_source(self.producer, self.head)["nativeInputsUnchanged"])

    def test_changed_worker_is_rejected_even_with_forged_local_receipt(self):
        folder = self.artifacts / "node-linux-x64-gnu"
        (folder / "utexo-rgb-native").write_bytes(b"foreign binary")
        (folder / "build-receipt.json").write_text(json.dumps({"binary": {"sha256": release.sha256(b"foreign binary")}}))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)

    def test_missing_target_is_rejected(self):
        del self.evidence["platforms"]["bare-android-ia32"]
        with self.assertRaisesRegex(ValueError, "Incomplete native target"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)

    def test_wrong_mobile_linked_name_is_rejected(self):
        self.native["targets"]["android-arm64"]["linkedName"] = "libold-sdk.so"
        with self.assertRaisesRegex(ValueError, "linked name differs"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)

    def test_node_abi_requirements_are_required_and_preserved(self):
        results = release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)
        self.assertEqual(results["node-linux-x64-gnu"]["abi"]["glibcVersions"], ["2.17", "2.34"])
        del self.evidence["platforms"]["node-linux-x64-gnu"]["abi"]
        with self.assertRaisesRegex(ValueError, "Missing reviewed Node ABI"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)

    def test_symlink_worker_is_rejected(self):
        binary = self.artifacts / "node-darwin-arm64/utexo-rgb-native"
        saved = self.root / "saved-worker"
        binary.rename(saved)
        binary.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native)

    def test_stale_native_source_or_lock_is_rejected(self):
        self.write("native/Cargo.lock", b"changed dependency source\n")
        self.head = self.commit()
        with self.assertRaisesRegex(ValueError, "Native build inputs changed"):
            release.verify_source(self.producer, self.head)

    def test_docs_only_commit_does_not_require_new_binaries(self):
        self.write("native/README.md", b"Clearer build instructions\n")
        self.head = self.commit()
        self.assertTrue(release.verify_source(self.producer, self.head)["nativeInputsUnchanged"])

    def test_runtime_drift_is_reported_separately_from_native_equivalence(self):
        self.write("onchain.js", b"export default 2\n")
        self.head = self.commit()
        result = release.verify_source(self.producer, self.head)
        self.assertTrue(result["nativeInputsUnchanged"])
        self.assertFalse(result["runtimeFilesUnchangedSinceProducer"])
        self.assertEqual(result["runtimeFilesChangedSinceProducer"], ["onchain.js"])

    def test_version_change_requires_new_admitted_binaries(self):
        self.package["version"] = "3.0.0-rc.2"
        self.write("package.json", json.dumps(self.package).encode())
        self.head = self.commit()
        with self.assertRaisesRegex(ValueError, "version differs"):
            release.verify_source(self.producer, self.head)

    def replace_tar(self, entries):
        self.archive.unlink()
        release.deterministic_tar(self.archive, entries)

    def test_duplicate_or_traversal_tar_member_is_rejected(self):
        for extra in [self.entries[0], ("package/../../outside", b"bad", False)]:
            with self.subTest(extra=extra[0]):
                self.replace_tar(self.entries + [extra])
                with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
                    self.verify_pack()

    def test_tar_link_is_rejected_without_extraction(self):
        with tarfile.open(self.archive, "w:gz") as tar:
            member = tarfile.TarInfo("package/onchain.js")
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            tar.addfile(member)
        with self.assertRaisesRegex(ValueError, "link, directory or special"):
            self.verify_pack()

    def test_changed_source_or_native_pin_is_rejected(self):
        for name in ["package/onchain.js", "package/prebuilds/linux-x64/utexo__wdk-wallet-rgb.bare"]:
            entries = [(path, b"foreign" if path == name else data, mode) for path, data, mode in self.entries]
            self.replace_tar(entries)
            with self.assertRaises(ValueError):
                self.verify_pack()

    def test_missing_pack_target_is_rejected(self):
        self.replace_tar(self.entries[1:])
        with self.assertRaisesRegex(ValueError, "Missing package members"):
            self.verify_pack()

    def test_release_archives_are_reproducible_and_executable(self):
        report = {"packageVersion": self.package["version"], "source": release.verify_source(self.producer, self.head),
                  "platforms": release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native),
                  "package": self.verify_pack()}
        first, second = self.root / "release-a", self.root / "release-b"
        release.assemble(first, self.archive, self.artifacts, self.evidence, report, self.head)
        release.assemble(second, self.archive, self.artifacts, self.evidence, report, self.head)
        self.assertEqual({p.name: release.file_identity(p) for p in first.iterdir()}, {p.name: release.file_identity(p) for p in second.iterdir()})
        node_archive = next(first.glob("*-node-linux-x64-gnu.tar.gz"))
        with tarfile.open(node_archive) as tar:
            self.assertEqual(tar.getmember("utexo-rgb-native").mode, 0o755)
            self.assertEqual(tar.extractfile("utexo-rgb-native").read(), b"node-linux-x64-gnu")
        with self.assertRaisesRegex(ValueError, "Output already exists"):
            release.assemble(first, self.archive, self.artifacts, self.evidence, report, self.head)

    def test_failed_assembly_leaves_no_partial_release(self):
        report = {"packageVersion": self.package["version"], "source": {},
                  "platforms": release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native),
                  "package": self.verify_pack()}
        output = self.root / "release"
        with patch.object(release, "deterministic_tar", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                release.assemble(output, self.archive, self.artifacts, self.evidence, report, self.head)
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(".wdk-release-*")), [])


if __name__ == "__main__":
    unittest.main()
