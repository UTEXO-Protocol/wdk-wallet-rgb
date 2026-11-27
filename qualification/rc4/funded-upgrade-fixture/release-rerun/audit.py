#!/usr/bin/env python3
"""Independently verify new CI pack transactions and proof commitments; no writes to wallets."""
import hashlib,json,pathlib,subprocess,sys
from decimal import Decimal
HERE=pathlib.Path(__file__).resolve().parent
Q=HERE.parent.parent
FIXTURE=Q/'fixture'
from local_fixture import fixture
FRESH=HERE/'issuer-fixture'
report=json.loads((HERE/'result.json').read_text())
assert report['complete']
before=json.loads((HERE/'before.json').read_text())
old=json.loads((FIXTURE/'packed-upgrade/evidence.json').read_text())
legacy=json.loads((HERE/'legacy-before.json').read_text());assert legacy['complete']
deployment=json.loads((FIXTURE/'deployment.json').read_text())
AID=report['assetId'];OLD_AID=old['assetId'];assert AID!=OLD_AID
BRIDGE=deployment['bridge']['deployedTo'];TOKEN=deployment['token']['deployedTo']
INSPECT=Q/'upstream-upgrade-audit/target/debug/contract-inspect'
sha=lambda b:hashlib.sha256(b).hexdigest()
def sats(value):
    n=Decimal(str(value))*100000000
    assert n==n.to_integral_exact()
    return int(n)
def transaction(txid):
    tx=fixture.rpc(48443,'getrawtransaction',[txid,True]);assert tx['txid']==txid and tx['confirmations']>=6
    vin=sum(sats(fixture.rpc(48443,'getrawtransaction',[v['txid'],True])['vout'][v['vout']]['value']) for v in tx['vin'])
    fee=vin-sum(sats(v['value']) for v in tx['vout']);assert 0<fee<=10000
    return tx,{'txid':txid,'confirmations':tx['confirmations'],'feeSats':fee,'vsize':tx['vsize']}
def uint(contract,signature,*args):
    return int(fixture.cast('call',contract,signature,*args,'--rpc-url','http://127.0.0.1:8545').split()[0],0)
assert fixture.rpc(48443,'getblockchaininfo')['chain']=='regtest'
assert int(fixture.rpc(48545,'eth_chainId'),16)==31337
rows=[]
cases=[(runtime,row,1000000,100000,'55',HERE/(runtime+'-burn.rgb'),False) for runtime,row in report['runtimes'].items()]+[(runtime,row,2000000,500000,'66',HERE/(runtime+'-legacy-burn.rgb'),True) for runtime,row in legacy['runtimes'].items()]
for runtime,row,expected_mint,expected_burn,destination_byte,proof,is_legacy in cases:
    mint=row['mint'];txid=mint['broadcast']['txid'];_,mint_btc=transaction(txid)
    saved=json.loads((FRESH/'issuer-state'/f'mint-{mint["operationId"]}.json').read_text())
    amount=saved['request']['amount'];deadline=saved['request']['beforeBlock'];lock=mint['prepared']['lockId']
    assert amount==expected_mint and mint['checked']['amount']==str(amount)
    receipt=fixture.rpc(48545,'eth_getTransactionReceipt',[mint['paymentTxid']]);assert int(receipt['status'],16)==1
    recorded=uint(BRIDGE,'getFundsInBlock(uint256,uint256)(uint64)','0x'+lock,str(amount))
    assert recorded==int(receipt['blockNumber'],16)+1 and recorded-1<deadline
    tx=fixture.rpc(48545,'eth_getTransactionByHash',[mint['paymentTxid']]);assert tx['to'].lower()==BRIDGE.lower()
    calldata=fixture.cast('calldata','fundsIn(uint256,uint256,uint64)',str(amount),'0x'+lock,str(deadline))
    assert tx['input'].lower()==calldata.lower()
    depth=int(fixture.rpc(48545,'eth_blockNumber'),16)-int(receipt['blockNumber'],16);assert depth>=64
    burn=row['burn'];burn_tx,burn_btc=transaction(burn['txid']);assert sha(proof.read_bytes())==burn['proofSha256']
    inspected=json.loads(subprocess.check_output([str(INSPECT),str(proof),burn['txid']],text=True))
    assert inspected['isTransfer'] and inspected['assetId']==AID and inspected['assetSchema']=='Bfa'
    assert len(inspected['witnesses'])==1
    witness=inspected['witnesses'][0];assert witness['txid']==burn['txid'] and witness['closeMethod']=='opretFirst'
    opreturns=[v['scriptPubKey']['hex'] for v in burn_tx['vout'] if v['scriptPubKey']['type']=='nulldata']
    assert opreturns[0]=='6a20'+witness['commitmentHex']
    transitions=[t for op in witness['operations'] if op['assetId']==AID for t in op['transitions'] if t['type']=='Burn'];assert len(transitions)==1
    transition=transitions[0];assert not transition['outputs']
    assert [g['BurnedAsset'] for g in transition['globals'] if isinstance(g,dict) and 'BurnedAsset' in g]==[expected_burn]
    typehash=fixture.cast('keccak','UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)')
    recipienthash=fixture.cast('keccak','0x'+destination_byte*20)
    preimage=fixture.cast('abi-encode','f(bytes32,uint64,uint32,bytes32)',typehash,'42161','0',recipienthash)
    expected=fixture.cast('keccak',preimage).removeprefix('0x')
    assert [g['BurnReason'] for g in transition['globals'] if isinstance(g,dict) and 'BurnReason' in g]==[expected]
    transfers=[]
    for name,value in ([] if is_legacy else [('bfa',row['bfaSend']),('btc',row['btcSend'])]+[(a['schema'],a) for a in row['ordinary']]):
        tx,detail=transaction(value['txid']);transfers.append({'kind':name,**detail})
        if name=='btc':assert any(v['scriptPubKey'].get('address')==row['btcAddress'] and sats(v['value'])==10000 for v in tx['vout'])
    rows.append({'runtime':runtime,'legacyPreparation':is_legacy,'mint':mint_btc,'mintedBaseUnits':str(amount),'evmLockTxid':mint['paymentTxid'],'evmFinalityDepth':depth,'lockCalldataMatched':True,
                 'burn':burn_btc,'burnedBaseUnits':str(expected_burn),'proofSha256':burn['proofSha256'],'independentProofDecoded':True,'destinationCommitment':expected,'commitmentComputedWithFoundry':True,'transfers':transfers})
route_rows=[]
for runtime,row in report['runtimes'].items():
    assert len(row['additionalRoutes'])==4
    for route in row['additionalRoutes']:
        tx,detail=transaction(route['txid'])
        proof=HERE/(runtime+'-burn-'+route['name']+'.rgb')
        assert sha(proof.read_bytes())==route['proofSha256']
        inspected=json.loads(subprocess.check_output([str(INSPECT),str(proof),route['txid']],text=True))
        assert inspected['isTransfer'] and inspected['assetId']==AID and inspected['assetSchema']=='Bfa'
        assert len(inspected['witnesses'])==1
        witness=inspected['witnesses'][0];assert witness['txid']==route['txid'] and witness['closeMethod']=='opretFirst'
        opreturns=[v['scriptPubKey']['hex'] for v in tx['vout'] if v['scriptPubKey']['type']=='nulldata']
        assert opreturns[0]=='6a20'+witness['commitmentHex']
        transitions=[t for op in witness['operations'] if op['assetId']==AID for t in op['transitions'] if t['type']=='Burn'];assert len(transitions)==1
        transition=transitions[0];assert not transition['outputs']
        assert [g['BurnedAsset'] for g in transition['globals'] if isinstance(g,dict) and 'BurnedAsset' in g]==[10000]
        if route['chainId'].startswith('tron:'):
            alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';number=0
            for letter in route['address']:number=number*58+alphabet.index(letter)
            decoded=number.to_bytes((number.bit_length()+7)//8,'big')
            payload,checksum=decoded[:-4],decoded[-4:]
            assert len(payload)==21 and payload[0]==0x41 and payload.hex()==route['recipientHex'][2:]
            assert hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]==checksum
        else:assert route['address'].lower()==route['recipientHex']
        typehash=fixture.cast('keccak','UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)')
        recipienthash=fixture.cast('keccak',route['recipientHex'])
        preimage=fixture.cast('abi-encode','f(bytes32,uint64,uint32,bytes32)',typehash,route['chainId'].split(':')[1],str(route['dstEid']),recipienthash)
        commitment=fixture.cast('keccak',preimage).removeprefix('0x')
        assert [g['BurnReason'] for g in transition['globals'] if isinstance(g,dict) and 'BurnReason' in g]==[commitment]
        assert route['repeatedRecoveryUnchanged'] and route['duplicateRejected'] and route['freshProcessRecoveryUnchanged']
        route_rows.append({'runtime':runtime,'chainId':route['chainId'],'dstEid':route['dstEid'],'recipientHex':route['recipientHex'],'bitcoin':detail,'burnedBaseUnits':'10000','proofSha256':route['proofSha256'],'independentCommitment':commitment,'proofDecodedAndMatchesBitcoin':True,'recoveredAfterFullProcessRestart':True,'duplicateRejected':True})
assert len(route_rows)==8
assert len({r['bitcoin']['txid'] for r in route_rows}|{r['burn']['txid'] for r in rows})==12
initial=sum(int(next(a for a in wallet['assets'] if a['assetId']==OLD_AID)['balance']['spendable']) for wallet in before['wallets'].values())
assert initial==14500000
new_final=sum(int(r['restart']['bfaSender'])+int(r['restart']['bfaRecipient']) for r in report['runtimes'].values())
assert new_final==6000000-1280000==4720000
final=initial+new_final
assert final==19220000
assert uint(TOKEN,'balanceOf(address)(uint256)',BRIDGE)==26000000
assert uint(BRIDGE,'circulatingSupply()(uint64)')==26000000
result={'source':report['source'],'packageSha256':report['packageSha256'],'rows':rows,'additionalRoutes':route_rows,'retainedAssetId':OLD_AID,'newAssetId':AID,'retainedBfaBaseUnits':str(initial),'newAssetFinalBaseUnits':str(new_final),'newlyMintedBaseUnits':'6000000','newlyBurnedBaseUnits':'1280000','finalBfaBaseUnits':str(final),'bridgeBackingBaseUnits':'26000000','independentProofInspectorSource':'567e5b8308f70a6242137475394be5a82fc15c95','proofInspectorSha256':sha(INSPECT.read_bytes()),'limitations':['No EVM fundsOut redemption; original and new burned units remain backed in the fixture.','Isolated Regtest and Anvil host execution; no hosted gateway/TEE, public-network payout or mobile acceptance.']}
(HERE/'financial-reconciliation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'verifiedRuntimes':2,'newMints':4,'newBurns':12,'v1RouteBurns':10,'confirmedTransfers':sum(len(r['transfers']) for r in rows),'finalBfaBaseUnits':str(final)}))
