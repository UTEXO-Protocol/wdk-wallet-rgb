#!/usr/bin/env python3
"""Read-only independent Bitcoin/RGB/EVM reconciliation of the fresh packed consumers."""
import hashlib,json,pathlib,subprocess,os
from decimal import Decimal
from local_fixture import fixture,SOURCE
HERE=pathlib.Path(__file__).resolve().parent
report=json.loads((HERE/'result.json').read_text());assert report['complete']
assert report['source']=='f4971e0165c2ed35ca74e65e3fd0071e4eed7f2d'
AID=report['assetId'];FRESH=HERE/'issuer-fixture'
deployment=json.loads((SOURCE/'deployment.json').read_text())
BRIDGE=deployment['bridge']['deployedTo'];TOKEN=deployment['token']['deployedTo']
INSPECT=pathlib.Path(os.environ['WDK_PROOF_INSPECTOR']).resolve(strict=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
fixture_identity=json.loads((HERE/'fixture-identity.json').read_text())
assert fixture_identity['issuerRgbSource']=='567e5b8308f70a6242137475394be5a82fc15c95'
assert fixture_identity['proofInspectorSha256']=='ddaadf27ad5500102fbc2fb82f5d86fa3c40532911fd3aa9473e1eef55edf216'
assert sha(INSPECT.read_bytes())==fixture_identity['proofInspectorSha256']
def sats(value):
 n=Decimal(str(value))*100000000;assert n==n.to_integral_exact();return int(n)
def transaction(txid):
 tx=fixture.rpc(48443,'getrawtransaction',[txid,True]);assert tx['txid']==txid and tx['confirmations']>=6
 vin=sum(sats(fixture.rpc(48443,'getrawtransaction',[v['txid'],True])['vout'][v['vout']]['value']) for v in tx['vin'])
 fee=vin-sum(sats(v['value']) for v in tx['vout']);assert 0<fee<=10000
 return tx,{'txid':txid,'confirmations':tx['confirmations'],'feeSats':fee,'vsize':tx['vsize']}
def decode(proof,entry,asset,schema,tx):
 assert sha(proof.read_bytes())==entry['proofSha256']
 decoded=json.loads(subprocess.check_output([str(INSPECT),str(proof),entry['txid']],text=True))
 assert decoded['isTransfer'] and decoded['assetId']==asset and decoded['assetSchema']==schema
 assert decoded['genesis']['chainNet']=='bcrt'
 if schema=='Bfa':assert decoded['genesis']['precision']==6 and decoded['genesis']['ticker']=='BUSDT'
 witnesses=decoded['witnesses'];assert len(witnesses)==1 and witnesses[0]['txid']==entry['txid']
 witness=witnesses[0];assert witness['closeMethod']=='opretFirst'
 opreturns=[v['scriptPubKey']['hex'] for v in tx['vout'] if v['scriptPubKey']['type']=='nulldata']
 assert opreturns[0]=='6a20'+witness['commitmentHex']
 return decoded,witness

def uint(contract,signature,*args):
 return int(fixture.cast('call',contract,signature,*args,'--rpc-url','http://127.0.0.1:8545').split()[0],0)
assert fixture.rpc(48443,'getblockchaininfo')['chain']=='regtest'
assert int(fixture.rpc(48545,'eth_chainId'),16)==31337
rows=[];routes=[]
for runtime,row in report['runtimes'].items():
 assert row['complete'] and row['bip322Verified']
 assert row['seedImport']['samePublicKeysAndSigningAddress'] and row['seedImport']['bitcoinFundsDiscovered']
 assert row['seedImport']['metadataImportWithoutInventedRgbBalance'] and row['seedImport']['rgbStateRequiresWalletBackup']
 assert row['contractImport']['noInventedAllocations']
 mint=row['mint'];_,mint_btc=transaction(mint['broadcast']['txid'])
 saved=json.loads((FRESH/'issuer-state'/f'mint-{mint["operationId"]}.json').read_text())
 amount=saved['request']['amount'];deadline=saved['request']['beforeBlock'];lock=mint['prepared']['lockId']
 assert amount==2000000 and mint['checked']['amount']==str(amount)
 receipt=fixture.rpc(48545,'eth_getTransactionReceipt',[mint['paymentTxid']]);assert int(receipt['status'],16)==1
 recorded=uint(BRIDGE,'getFundsInBlock(uint256,uint256)(uint64)','0x'+lock,str(amount))
 assert recorded==int(receipt['blockNumber'],16)+1 and recorded-1<deadline
 tx=fixture.rpc(48545,'eth_getTransactionByHash',[mint['paymentTxid']]);assert tx['to'].lower()==BRIDGE.lower()
 calldata=fixture.cast('calldata','fundsIn(uint256,uint256,uint64)',str(amount),'0x'+lock,str(deadline));assert tx['input'].lower()==calldata.lower()
 depth=int(fixture.rpc(48545,'eth_blockNumber'),16)-int(receipt['blockNumber'],16);assert depth>=64
 transfers=[]
 for kind,value in [('bfa',row['bfaSend']),('btc',row['btcSend'])]+[(a['schema'],a) for a in row['ordinary']]:
  tx,detail=transaction(value['txid']);transfers.append({'kind':kind,**detail})
  if kind=='btc':
   assert any(v['scriptPubKey'].get('address')==row['btcAddress'] and sats(v['value'])==10000 for v in tx['vout']);continue
  is_bfa=kind=='bfa';asset=AID if is_bfa else value['assetId'];schema='Bfa' if is_bfa else value['schema']
  proof=HERE/(runtime+'-bfa-send.rgb' if is_bfa else runtime+'-'+schema+'.rgb')
  decoded,witness=decode(proof,value,asset,schema,tx)
  movements=[t for op in witness['operations'] if op['assetId']==asset for t in op['transitions'] if t['type']=='Transfer'];assert len(movements)==1
  movement=movements[0];expected_input=2000000 if is_bfa else 1000;expected_outputs=[100000,1900000] if is_bfa else [100,900]
  assert sum(i['assignment']['Fungible'] for i in movement['inputs'])==expected_input
  assert sorted(o['assignment']['Fungible'] for o in movement['outputs'])==expected_outputs
  public={'assetId':asset,'schema':schema,'proofSha256':value['proofSha256'],'rgbInputAmount':str(expected_input),'rgbOutputs':list(map(str,expected_outputs)),'independentProofDecoded':True,'bitcoinCommitmentMatched':True}
  if not is_bfa:
   assert value['freshProcessRecoveryUnchanged'];genesis=decoded['genesis'];assert genesis['precision']==2
   if schema=='Nia':assert genesis['ticker']=='VTEST'
   assert sum(o['assignment']['Fungible'] for o in genesis['outputs'])==1000
   anchors=[]
   for output in genesis['outputs']:
    assert not output['isConcealed'];anchor=fixture.rpc(48443,'getrawtransaction',[output['txid'],True]);assert anchor['confirmations']>=6
    assert 0<=output['vout']<len(anchor['vout']);anchors.append({'txid':output['txid'],'vout':output['vout'],'confirmations':anchor['confirmations']})
   public.update({'issuedSupply':'1000','finalIssuerBalance':'900','finalRecipientBalance':'100','issuanceAnchors':anchors,'issuanceAndTransferConserved':True})
  transfers[-1]['rgb']=public
 funding=[]
 for role in ['sender','receiver']:
  tx,detail=transaction(row[role]['fundingTxid']);assert any(v['scriptPubKey'].get('address')==row[role]['address'] and sats(v['value'])==2000000 for v in tx['vout'])
  _,outputs=transaction(row[role]['outputs']['txid']);funding.append({'role':role,'funding':detail,'outputs':outputs})
 rows.append({'runtime':runtime,'funding':funding,'mint':mint_btc,'mintedBaseUnits':str(amount),'evmLockTxid':mint['paymentTxid'],'evmFinalityDepth':depth,'lockCalldataMatched':True,'transfers':transfers})
 assert len(row['burns'])==5
 for route in row['burns']:
  tx,detail=transaction(route['txid']);proof=HERE/(runtime+'-burn-'+route['name']+'.rgb')
  _,witness=decode(proof,route,AID,'Bfa',tx)
  transitions=[t for op in witness['operations'] if op['assetId']==AID for t in op['transitions'] if t['type']=='Burn'];assert len(transitions)==1
  transition=transitions[0];assert not transition['outputs']
  assert [g['BurnedAsset'] for g in transition['globals'] if isinstance(g,dict) and 'BurnedAsset' in g]==[int(route['amount'])]
  if route['chainId'].startswith('tron:'):
   alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';number=0
   for letter in route['address']:number=number*58+alphabet.index(letter)
   decoded=number.to_bytes((number.bit_length()+7)//8,'big');payload,checksum=decoded[:-4],decoded[-4:]
   assert len(payload)==21 and payload[0]==0x41 and payload.hex()==route['recipientHex'][2:]
   assert hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]==checksum
  else:assert route['address'].lower()==route['recipientHex']
  typehash=fixture.cast('keccak','UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)');recipienthash=fixture.cast('keccak',route['recipientHex'])
  preimage=fixture.cast('abi-encode','f(bytes32,uint64,uint32,bytes32)',typehash,route['chainId'].split(':')[1],str(route['dstEid']),recipienthash)
  commitment=fixture.cast('keccak',preimage).removeprefix('0x')
  assert [g['BurnReason'] for g in transition['globals'] if isinstance(g,dict) and 'BurnReason' in g]==[commitment]
  assert route['repeatedRecoveryUnchanged'] and route['duplicateRejected'] and route['freshProcessRecoveryUnchanged']
  if route['name']=='arbitrum':assert route['lostSuccessfulNativeEndReply'] and route['burnEndCalls']==1
  routes.append({'runtime':runtime,'chainId':route['chainId'],'dstEid':route['dstEid'],'recipientHex':route['recipientHex'],'bitcoin':detail,'burnedBaseUnits':route['amount'],'proofSha256':route['proofSha256'],'independentCommitment':commitment,'proofDecodedAndMatchesBitcoin':True,'recoveredAfterFullProcessRestart':True,'duplicateRejected':True})
assert len(rows)==2 and len(routes)==10
assert len({t['txid'] for r in rows for t in r['transfers']})==8
assert len({a['assetId'] for r in report['runtimes'].values() for a in r['ordinary']})==4
assert len({r['bitcoin']['txid'] for r in routes})==10
minted=sum(int(r['mintedBaseUnits']) for r in rows);burned=sum(int(r['burnedBaseUnits']) for r in routes)
final=sum(int(r['restart']['bfaSender'])+int(r['restart']['bfaRecipient']) for r in report['runtimes'].values())
assert minted==4000000 and burned==280000 and final==minted-burned==3720000
before=json.loads((HERE/'backing-before.json').read_text());backing_after=int(before['bridgeBackingBefore'])+minted
assert uint(TOKEN,'balanceOf(address)(uint256)',BRIDGE)==backing_after
assert uint(BRIDGE,'circulatingSupply()(uint64)')==int(before['circulatingSupplyBefore'])+minted
result={'source':report['source'],'packageSource':report['packageSource'],'packageSha256':report['packageSha256'],'nativeProducers':report['nativeProducers'],'rows':rows,'routes':routes,'assetId':AID,'mintedBaseUnits':str(minted),'burnedBaseUnits':str(burned),'finalBfaBaseUnits':str(final),'bridgeBackingBefore':before['bridgeBackingBefore'],'bridgeBackingAfter':str(backing_after),'independentProofInspectorSource':fixture_identity['issuerRgbSource'],'proofInspectorSha256':sha(INSPECT.read_bytes()),'limitations':['Local MinimalBridge verifies fundsIn; no TEE or hosted gateway acceptance and no EVM payout/redemption.','Funded Darwin ARM64 Node and Bare; other targets qualify separately.','Fresh wallets and same-version recovery only; no legacy BFA database upgrade claim.','Seed-only import restores Bitcoin identity but cannot reconstruct private RGB allocations.']}
(HERE/'financial-reconciliation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'verifiedRuntimes':2,'mints':2,'v1RouteBurns':10,'confirmedTransfers':8,'ordinaryIssuanceAssets':4,'finalBfaBaseUnits':str(final)}))
