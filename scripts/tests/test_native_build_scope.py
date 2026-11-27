"""Native target selection must retain shared and Bare build coverage."""
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).parents[1] / 'native-build-scope.py'
SPEC = importlib.util.spec_from_file_location('native_scope', SCRIPT)
scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scope)
WORKFLOW = (SCRIPT.parents[1] / '.github/workflows/build.yml').read_text()


class NativeScopeTests(unittest.TestCase):
    def choose(self, files, before='', after=''):
        return scope.select(files, lambda _: before, lambda _: after)

    def test_node_adapter_only(self):
        self.assertEqual(self.choose(['native/node/binding.c', 'native/Cargo.toml', 'native/src/main.rs']), (True, False))

    def test_shared_engine_rebuilds_both(self):
        self.assertEqual(self.choose(['native/src/engine.rs']), (True, True))
        self.assertEqual(self.choose(['native/scripts/prepare-source.py']), (True, True))
        self.assertEqual(self.choose(['src/onchain-dev-services.json']), (True, True))

    def test_bare_lock_rebuilds_bare(self):
        self.assertEqual(self.choose(['native/bare/Cargo.lock']), (False, True))

    def test_unknown_native_inputs_rebuild_both(self):
        self.assertEqual(self.choose(['native/new-input.bin']), (True, True))

    def test_runtime_and_docs_do_not_recompile(self):
        self.assertEqual(self.choose(['src/onchain-wallet.js', 'native/node/README.md']), (False, False))

    def test_version_change_rebuilds_linked_library_names(self):
        self.assertEqual(self.choose(['package.json'], '{"version":"1.0.0"}', '{"version":"1.0.1"}'), (True, True))
        self.assertEqual(self.choose(['package.json'], '{"version":"1.0.0"}', '{"version":"1.0.0","files":[]}'), (False, False))

    def test_node_specific_workflow_change_retains_bare(self):
        changed = WORKFLOW.replace('node native/scripts/node-host.mjs build "$TARGET"', 'node native/scripts/node-host.mjs build-new "$TARGET"')
        self.assertNotEqual(WORKFLOW, changed)
        self.assertEqual(self.choose(['.github/workflows/build.yml'], WORKFLOW, changed), (True, False))

    def test_bare_or_shared_workflow_change_rebuilds_bare(self):
        for text in ['bash native/scripts/build-bare.sh', "CARGO_BUILD_JOBS: '3'", 'bash native/scripts/build-bare-ios.sh']:
            changed = WORKFLOW.replace(text, text + '-changed')
            self.assertNotEqual(WORKFLOW, changed)
            self.assertEqual(self.choose(['.github/workflows/build.yml'], WORKFLOW, changed), (True, True))

    def test_unknown_workflow_layout_rebuilds_bare(self):
        self.assertEqual(self.choose(['.github/workflows/build.yml'], WORKFLOW, 'jobs: {}'), (True, True))


if __name__ == '__main__':
    unittest.main()
