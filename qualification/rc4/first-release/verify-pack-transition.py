#!/usr/bin/env python3
"""Prove complete distribution retains exact native/runtime inputs of expiry fixture."""
import hashlib,json,pathlib,sys,tarfile
old_consumer,new_consumer,archive,cancellation=map(pathlib.Path,sys.argv[1:])
old=old_consumer/'node_modules/@utexo/wdk-wallet-rgb';new=new_consumer/'node_modules/@utexo/wdk-wallet-rgb'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
state=json.loads((cancellation/'private-state.json').read_text())
version=json.loads((new/'package.json').read_text())['version']
lock=json.loads((new_consumer/'package-lock.json').read_text())
installed=lock['packages']['node_modules/@utexo/wdk-wallet-rgb'];assert installed['resolved'].startswith('file:')
with tarfile.open(archive) as tar:
 for item in tar.getmembers():
  if item.isdir():continue
  assert item.isfile() and item.name.startswith('package/')
  relative=pathlib.PurePosixPath(item.name).relative_to('package');assert '..' not in relative.parts
  assert (new/str(relative)).read_bytes()==tar.extractfile(item).read()
def runtime_files(root):
 return {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and (p.relative_to(root).parts[0]=='src' or p.name.endswith(('.js','.cjs','.d.ts')) or p.relative_to(root)==pathlib.Path('package.json'))}
assert runtime_files(old)==runtime_files(new), 'Final pack added/removed runtime files'
files={}
for p in old.rglob('*'):
 if not p.is_file():continue
 relative=p.relative_to(old)
 if relative.parts[0] in ('src','prebuilds') or p.name.endswith(('.js','.cjs','.d.ts')) or relative==pathlib.Path('package.json'):
  counterpart=new/relative;assert counterpart.is_file(),relative
  if relative.name in ('onchain-bare-native.json','onchain-node-native.json'):
   before=json.loads(p.read_text());after=json.loads(counterpart.read_text())
   for target,pin in before['targets'].items():assert pin==after['targets'][target]
   assert len(before['targets'])<=1
   if before['targets']:assert before['releaseHold'] is False
   before.pop('releaseHold');assert after.pop('releaseHold') is False
   before.pop('targets');after.pop('targets')
   assert before.pop('publicationHold') is True
   assert isinstance(after.pop('publicationHold'),bool)
   assert before==after
  else:
   assert p.read_bytes()==counterpart.read_bytes(),relative
   if relative.parts[0]!='prebuilds':files[str(relative)]=sha(p)
for runtime,filename,count in [('node','utexo-rgb-native.node',5),('bare','utexo__wdk-wallet-rgb.bare',11)]:
 manifest=json.loads((new/'src'/f'onchain-{runtime}-native.json').read_text());assert len(manifest['targets'])==count
 assert manifest['releaseHold'] is False
 for target,pin in manifest['targets'].items():
  p=new/'prebuilds'/target/filename;assert p.stat().st_size==pin['byteLength'] and sha(p)==pin['sha256']
identity={'version':version,'integrity':installed['integrity'],'source':manifest['source'],'tree':manifest['overlayTree'],'nodeSha256':sha(new/'prebuilds/darwin-arm64/utexo-rgb-native.node'),'bareSha256':sha(new/'prebuilds/darwin-arm64/utexo__wdk-wallet-rgb.bare')}
if 'bareSha256' not in state['identity']:identity.pop('bareSha256')
for key in ('version','source','tree','nodeSha256',*(['bareSha256'] if 'bareSha256' in state['identity'] else [])):assert identity[key]==state['identity'][key]
receipt={'preparedIdentity':state['identity'],'finalIdentity':identity,'finalPackageSha256':sha(archive),'runtimeAndNativeBytesIdentical':True,'allowedDifferencesOnly':True,'allowedDifferences':['Additional separately admitted native targets','Native manifest publication hold and target matrix','Non-executable documentation'], 'runtimeFiles':files}
(cancellation/'final-pack-equivalence.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'runtimeFilesCompared':len(files),'completeNativeTargetCount':16,'finalPackageSha256':receipt['finalPackageSha256']}))
