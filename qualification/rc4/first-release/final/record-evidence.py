#!/usr/bin/env python3
"""Publish only public fixture receipts; never include wallet keys/state or raw proofs."""
import hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parent
read=lambda name:json.loads((ROOT/name).read_text())
sha=lambda data:hashlib.sha256(data).hexdigest()
def save(name,value):
 data=(json.dumps(value,indent=2)+'\n').encode();(ROOT/name).write_bytes(data);return sha(data)
def no_private(value):
 if isinstance(value,dict):
  for key,item in value.items():
   assert key not in ('seed','mnemonic','privateKey','privateKeys','dataDir','signedPsbt'),key
   no_private(item)
 elif isinstance(value,list):
  for item in value:no_private(item)
financial=read('financial-reconciliation.json');no_private(financial)
financial_sha=save('financial-release.json',financial)
funded=read('result.json');assert funded['complete']
for row in funded['runtimes'].values():
 for key in ('keys','signingAddress','signature'):row.pop(key,None)
 for role in ('sender','receiver'):row[role].pop('address',None)
 row['seedImport'].pop('originalBtc',None);row['seedImport'].pop('restoredBtc',None)
funded.update({'schemaVersion':1,'packageVersion':'3.0.0-rc.4','financialReconciliation':'financial-release.json','financialReconciliationSha256':financial_sha,'runnerIdentities':read('runner-identities.json'),'fixtureIdentity':read('fixture-identity.json')})
no_private(funded);funded_sha=save('funded-release.json',funded)
if (ROOT/'final-packed-recovery.json').exists():
 final=read('final-packed-recovery.json');assert final['complete']
 final['runnerSha256']=sha((ROOT/'final-recovery.mjs').read_bytes())
 final['equivalenceReceiptSha256']=sha((ROOT/'funded-final-equivalence.json').read_bytes())
 final['initialAdmissionHarnessCorrection']={'reason':'Final release-verifier receipt omits qualification-only holds/publicationAllowed fields. The helper was corrected to read the actual final receipt and validate both installed manifest holds.','beforeWalletOpen':True,'financialOperationsReplayed':False}
 no_private(final);save('final-packed-recovery.json',final)
cancellation={}
for runtime in ('node','bare'):
 result=read(f'cancellation-{runtime}/cancellation.json')
 if result['phase']!='passed':continue
 transition=read(f'cancellation-{runtime}/final-pack-equivalence.json')
 assert result['identity']==transition['finalIdentity']
 no_private(result);no_private(transition)
 cancellation[runtime]={'acceptance':result,'scopedPreparationPackageSha256':read(f'scoped-{ "node" if runtime=="node" else "darwin2" }-pack.json')['packageSha256'],'finalPackEquivalence':transition}
if len(cancellation)==2:
 result={'schemaVersion':1,'packageVersion':'3.0.0-rc.4','rgbSource':funded['source'],'finalPackageSource':read('final-packed-recovery.json')['packageSource'],'finalPackageSha256':read('final-packed-recovery.json')['packageSha256'],'originalFundedPackageSource':funded['packageSource'],'originalFundedPackageSha256':funded['packageSha256'],'scope':'Real-expiry ordinary receive cancellation on final packed Node and Bare Darwin ARM64 consumers; scoped packs only prepared the invoices.','results':cancellation,'runnerSha256':sha((ROOT/'qualify-stock-cancellation.mjs').read_bytes()),'transitionVerifierSha256':sha((ROOT/'verify-pack-transition.py').read_bytes()),'machineClockChanged':False,'walletRowsEdited':False}
 no_private(result);save('cancellation-release.json',result)
print(json.dumps({'fundedReceiptSha256':funded_sha,'financialReceiptSha256':financial_sha,'expiredCancellationRuntimesPassed':list(cancellation)}))
