#!/usr/bin/env python3
"""Finish the two prepared real-expiry fixtures with the final archive, without replay."""
import datetime,json,pathlib,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parent
for runtime in ('node','bare'):
 receipt=json.loads((ROOT/f'cancellation-{runtime}/cancellation.json').read_text())
 assert receipt['phase']=='awaiting-expiry', 'Do not replay an already completed or interrupted financial phase'
 deadline=datetime.datetime.fromisoformat(receipt['readyAfter'].replace('Z','+00:00')).timestamp()
 assert deadline-time.time()<7200
 print(f'{runtime}: waiting for real expiry {receipt["readyAfter"]}',flush=True)
 while time.time()<=deadline:time.sleep(min(30,deadline-time.time()+0.1))
 log=ROOT/f'cancellation-{runtime}-finish.log'
 assert not log.exists(), 'An earlier finish attempt needs explicit reconciliation'
 with log.open('x') as output:
  subprocess.run(['node',str(ROOT/'qualify-stock-cancellation.mjs'),str(ROOT/'final-consumer'),str(ROOT/'final-consumer/node_modules/@utexo/wdk-wallet-rgb/prebuilds/darwin-arm64/utexo-rgb-native.node'),str(ROOT/f'cancellation-{runtime}-fixture.json'),str(ROOT/f'cancellation-{runtime}'),'finish'],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True)
 passed=json.loads((ROOT/f'cancellation-{runtime}/cancellation.json').read_text());assert passed['phase']=='passed'
 print(f'{runtime}: final packed cancellation and restart passed',flush=True)
subprocess.run(['python3',str(ROOT/'record-evidence.py')],cwd=ROOT,check=True)
