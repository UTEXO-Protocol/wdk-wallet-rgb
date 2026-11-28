"""Failure-oriented checks for release artifact admission, without native builds."""

import importlib.util
import io
import json
from contextlib import redirect_stdout
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
        self.node_native = {"targets": {}}
        self.evidence = {"packageVersion": self.package["version"], "producerCommit": self.producer,
                         "count": 16, "platforms": {}, "packedBareTargets": {}, "packedNodeTargets": {}}
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
            self.add_binary("node-" + target, "utexo-rgb-native.node")
            data = ("node-" + target).encode()
            pin = {"sha256": release.sha256(data), "byteLength": len(data)}
            self.node_native["targets"][target] = pin
            self.evidence["packedNodeTargets"][target] = {"pin": pin, "producerCommit": self.producer}
            self.entries.append(("package/prebuilds/" + target + "/utexo-rgb-native.node", data, False))
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
        return release.verify_pack(self.archive, self.head, self.package, self.native, self.node_native)

    def test_complete_set_and_pack_are_admitted(self):
        self.assertEqual(len(release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)), 16)
        self.assertEqual(len(self.verify_pack()["files"]), len(self.entries))
        self.assertTrue(release.verify_source(self.producer, self.head)["nativeInputsUnchanged"])

    def test_changed_worker_is_rejected_even_with_forged_local_receipt(self):
        folder = self.artifacts / "node-linux-x64-gnu"
        (folder / "utexo-rgb-native.node").write_bytes(b"foreign binary")
        (folder / "build-receipt.json").write_text(json.dumps({"binary": {"sha256": release.sha256(b"foreign binary")}}))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_missing_target_is_rejected(self):
        del self.evidence["platforms"]["bare-android-ia32"]
        with self.assertRaisesRegex(ValueError, "Incomplete native target"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_wrong_mobile_linked_name_is_rejected(self):
        self.native["targets"]["android-arm64"]["linkedName"] = "libold-sdk.so"
        with self.assertRaisesRegex(ValueError, "linked name differs"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_node_abi_requirements_are_required_and_preserved(self):
        results = release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)
        self.assertEqual(results["node-linux-x64-gnu"]["abi"]["glibcVersions"], ["2.17", "2.34"])
        del self.evidence["platforms"]["node-linux-x64-gnu"]["abi"]
        with self.assertRaisesRegex(ValueError, "Missing reviewed Node ABI"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_symlink_worker_is_rejected(self):
        binary = self.artifacts / "node-darwin-arm64/utexo-rgb-native.node"
        saved = self.root / "saved-worker"
        binary.rename(saved)
        binary.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_stale_native_source_or_lock_is_rejected(self):
        self.write("native/Cargo.lock", b"changed dependency source\n")
        self.head = self.commit()
        with self.assertRaisesRegex(ValueError, "Native build inputs changed"):
            release.verify_source(self.producer, self.head)

    def test_docs_only_commit_does_not_require_new_binaries(self):
        self.write("native/README.md", b"Clearer build instructions\n")
        self.head = self.commit()
        self.assertTrue(release.verify_source(self.producer, self.head)["nativeInputsUnchanged"])

    def test_node_only_sources_do_not_invalidate_bare_artifacts(self):
        self.write("native/node/binding.c", b"node adapter\n")
        self.write("native/Cargo.toml", b"node adapter manifest\n")
        self.head = self.commit()
        self.assertTrue(release.verify_source(self.producer, self.head, "bare")["nativeInputsUnchanged"])
        with self.assertRaisesRegex(ValueError, "Native build inputs changed"):
            release.verify_source(self.producer, self.head, "node")
        self.write("native/src/engine.rs", b"shared engine changed\n")
        self.head = self.commit()
        with self.assertRaisesRegex(ValueError, "Native build inputs changed"):
            release.verify_source(self.producer, self.head, "bare")

    def test_bare_pin_must_match_the_reviewed_binary(self):
        self.native["targets"]["android-arm64"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Packed Bare pin differs from binary"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_node_pin_must_match_the_reviewed_binary(self):
        self.node_native["targets"]["linux-x64-gnu"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Packed Node pin differs from binary"):
            release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native)

    def test_runtime_drift_is_reported_separately_from_native_equivalence(self):
        self.write("onchain.js", b"export default 2\n")
        self.head = self.commit()
        result = release.verify_source(self.producer, self.head)
        self.assertTrue(result["nativeInputsUnchanged"])
        self.assertFalse(result["runtimeFilesUnchangedSinceProducer"])
        self.assertEqual(result["runtimeFilesChangedSinceProducer"], ["onchain.js"])

    def test_functional_qualification_pack_is_not_publishable(self):
        with self.assertRaisesRegex(ValueError, "publication is on hold"):
            release.verify_native_admission({"releaseHold": False, "publicationHold": True})
        release.verify_native_admission({"releaseHold": False})
        with self.assertRaisesRegex(ValueError, "artifact admission is on hold"):
            release.verify_native_admission({"releaseHold": True})

    def prepare_cli_source(self, *, publication_hold=True, release_hold=False):
        self.native.update({"releaseHold": release_hold, "publicationHold": publication_hold,
                            "source": "fixture", "overlayTree": "a" * 40,
                            "integrationTree": "a" * 40, "protocol": 1})
        self.node_native.update({key: self.native[key] for key in ("releaseHold", "publicationHold", "source", "overlayTree", "integrationTree", "protocol")})
        self.node_native.update({"runtime": "node-in-process", "nodeApiVersion": 8})
        self.write("src/onchain-bare-native.json", json.dumps(self.native).encode())
        self.write("src/onchain-node-native.json", json.dumps(self.node_native).encode())
        self.write("qualification/rc4/platforms.json", json.dumps(self.evidence).encode())
        self.head = self.commit()

    def run_cli(self, *options):
        args = [str(SCRIPT), "--archive", str(self.archive), "--artifacts", str(self.artifacts),
                "--qualification", "qualification/rc4/platforms.json", *options]
        output = io.StringIO()
        with patch("sys.argv", args), redirect_stdout(output):
            release.main()
        return json.loads(output.getvalue())

    def test_default_cli_rejects_publication_hold_even_without_output(self):
        self.prepare_cli_source()
        with self.assertRaisesRegex(ValueError, "publication is on hold"):
            self.run_cli()

    def test_qualification_cli_verifies_complete_set_and_reports_hold(self):
        self.prepare_cli_source()
        result = self.run_cli("--verify-qualification")
        self.assertTrue(result["qualificationOnly"])
        self.assertFalse(result["publicationAllowed"])
        self.assertEqual(result["holds"], {"releaseHold": False, "publicationHold": True})
        self.assertEqual(len(result["publicationBlockers"]), 2)
        self.assertEqual(len(result["platforms"]), 16)
        self.assertEqual(result["package"]["sha256"], release.file_identity(self.archive)["sha256"])
        self.assertTrue(result["source"]["node"]["nativeInputsUnchanged"])
        self.assertNotIn("assets", result)
        self.assertEqual(json.loads(release.blob(self.head, "src/onchain-bare-native.json")), self.native)

    def test_qualification_cli_never_allows_output_or_publication(self):
        output = self.root / "release"
        for hold in [True, False]:
            with self.subTest(publication_hold=hold):
                self.prepare_cli_source(publication_hold=hold)
                with self.assertRaisesRegex(ValueError, "cannot assemble release assets"):
                    self.run_cli("--verify-qualification", "--output", str(output))
                self.assertFalse(output.exists())
                result = self.run_cli("--verify-qualification")
                self.assertFalse(result["publicationAllowed"])
                self.assertEqual(result["holds"]["publicationHold"], hold)
                self.assertGreaterEqual(len(result["publicationBlockers"]), 1)

    def test_qualification_cli_still_requires_native_admission(self):
        self.prepare_cli_source(release_hold=True)
        with self.assertRaisesRegex(ValueError, "artifact admission is on hold"):
            self.run_cli("--verify-qualification")

    def test_qualification_cli_rejects_changed_binary(self):
        self.prepare_cli_source()
        (self.artifacts / "node-linux-x64-gnu/utexo-rgb-native.node").write_bytes(b"foreign")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.run_cli("--verify-qualification")

    def test_qualification_cli_rejects_native_input_drift(self):
        self.prepare_cli_source()
        self.write("native/Cargo.lock", b"changed dependencies\n")
        self.head = self.commit()
        with self.assertRaisesRegex(ValueError, "Native build inputs changed"):
            self.run_cli("--verify-qualification")

    def test_qualification_cli_rejects_changed_pack(self):
        self.prepare_cli_source()
        entries = [(path, b"foreign" if path == "package/onchain.js" else data, mode)
                   for path, data, mode in self.entries]
        self.replace_tar(entries)
        with self.assertRaisesRegex(ValueError, "differs from committed source"):
            self.run_cli("--verify-qualification")

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

    def test_release_contains_all_addons_in_one_reproducible_archive(self):
        report = {"packageVersion": self.package["version"], "source": release.verify_source(self.producer, self.head),
                  "platforms": release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native),
                  "package": self.verify_pack()}
        first, second = self.root / "release-a", self.root / "release-b"
        release.assemble(first, self.archive, self.artifacts, self.evidence, report, self.head)
        release.assemble(second, self.archive, self.artifacts, self.evidence, report, self.head)
        self.assertEqual({p.name: release.file_identity(p) for p in first.iterdir()}, {p.name: release.file_identity(p) for p in second.iterdir()})
        self.assertEqual({path.name for path in first.iterdir()}, {"sdk.tgz", "release-manifest.json", "SHA256SUMS"})
        with tarfile.open(first / "sdk.tgz") as tar:
            self.assertEqual(tar.getmember("package/prebuilds/linux-x64-gnu/utexo-rgb-native.node").mode, 0o644)
            self.assertEqual(tar.extractfile("package/prebuilds/linux-x64-gnu/utexo-rgb-native.node").read(), b"node-linux-x64-gnu")
        with self.assertRaisesRegex(ValueError, "Output already exists"):
            release.assemble(first, self.archive, self.artifacts, self.evidence, report, self.head)

    def test_failed_assembly_leaves_no_partial_release(self):
        report = {"packageVersion": self.package["version"], "source": {},
                  "platforms": release.verify_platforms(self.evidence, self.artifacts, self.package["version"], self.native, self.node_native),
                  "package": self.verify_pack()}
        output = self.root / "release"
        with patch.object(release.shutil, "copyfile", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                release.assemble(output, self.archive, self.artifacts, self.evidence, report, self.head)
        self.assertFalse(output.exists())
        self.assertEqual(list(self.root.glob(".wdk-release-*")), [])


if __name__ == "__main__":
    unittest.main()
