#!/usr/bin/env python3
"""Fresh issuer state on the existing owned qualification services; preserve original issuer."""
import importlib.util,pathlib,shutil
HERE=pathlib.Path(__file__).resolve().parent
SOURCE=HERE.parent.parent/'fixture'
spec=importlib.util.spec_from_file_location('owned_fixture',SOURCE/'fixture.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
fixture.ROOT=HERE/'issuer-fixture'
fixture.ROOT.mkdir(mode=0o700,exist_ok=True)
# Reuse the deployed local test contract, never a hosted contract. Each mint's
# lock commits to its own new asset operation; EVM backing is reconciled across
# the retained and fresh test assets separately.
if not (fixture.ROOT/'deployment.json').exists():
    shutil.copyfile(SOURCE/'deployment.json',fixture.ROOT/'deployment.json')
if __name__=='__main__':fixture.main()
