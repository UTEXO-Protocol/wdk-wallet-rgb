#!/usr/bin/env python3
"""Compare the exact funded qualification archive with the final publication archive."""
import hashlib,json,pathlib,sys,tarfile
old,new=map(pathlib.Path,sys.argv[1:]);HERE=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def files(path):
 out={}
 with tarfile.open(path) as tar:
  for entry in tar.getmembers():
   if entry.isdir():continue
   assert entry.isfile() and entry.name.startswith('package/')
   name=pathlib.PurePosixPath(entry.name).relative_to('package');assert '..' not in name.parts and str(name) not in out
   out[str(name)]=tar.extractfile(entry).read()
 return out
before=files(old);after=files(new);assert before.keys()==after.keys() and len(before)==48
funded=json.loads((HERE/'result.json').read_text());assert funded['complete'] and sha(old.read_bytes())==funded['packageSha256']
different={name for name in before if before[name]!=after[name]}
assert different=={'README.md','src/onchain-node-native.json','src/onchain-bare-native.json'},different
for runtime,count in [('node',5),('bare',11)]:
 name=f'src/onchain-{runtime}-native.json';old_manifest=json.loads(before[name]);new_manifest=json.loads(after[name])
 assert old_manifest.pop('publicationHold') is True and new_manifest.pop('publicationHold') is False
 assert old_manifest==new_manifest and len(new_manifest['targets'])==count and new_manifest['releaseHold'] is False
 for target,pin in new_manifest['targets'].items():
  filename='utexo-rgb-native.node' if runtime=='node' else 'utexo__wdk-wallet-rgb.bare'
  content=after[f'prebuilds/{target}/{filename}'];assert len(content)==pin['byteLength'] and sha(content)==pin['sha256']
result={'qualifiedPackageSha256':sha(old.read_bytes()),'finalPackageSha256':sha(new.read_bytes()),'fileCount':48,'nativeTargetCount':16,'allRuntimeAndNativeBytesIdentical':True,'allOtherFilesByteIdentical':True,'differences':{'README.md':'Documentation only','src/onchain-node-native.json':'publicationHold true to false only','src/onchain-bare-native.json':'publicationHold true to false only'},'files':{name:sha(content) for name,content in after.items()}}
(HERE/'funded-final-equivalence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='files'}))
