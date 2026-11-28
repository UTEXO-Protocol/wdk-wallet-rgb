#!/usr/bin/env python3
"""Read-only financial reconciliation of the owned regtest qualification fixture."""
import hashlib,json,pathlib,subprocess
from decimal import Decimal
import fixture
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/'packed-upgrade'
E=json.loads((OUT/'evidence.json').read_text())
D=json.loads((ROOT/'deployment.json').read_text())
AID=E['assetId'];BRIDGE=D['bridge']['deployedTo'];TOKEN=D['token']['deployedTo']
INSPECT=ROOT.parent/'upstream-upgrade-audit/target/debug/contract-inspect'
sha=lambda b:hashlib.sha256(b).hexdigest()
def sats(value):
    amount=Decimal(str(value))*100000000
    assert amount==amount.to_integral_exact()
    return int(amount)
def call_uint(contract,signature,*args):
    return int(fixture.cast('call',contract,signature,*args,'--rpc-url','http://127.0.0.1:8545').split()[0],0)
def chain_transaction(txid):
    tx=fixture.rpc(48443,'getrawtransaction',[txid,True]);assert tx['txid']==txid;assert tx['confirmations']>=6
    inputs=sum(sats(fixture.rpc(48443,'getrawtransaction',[vin['txid'],True])['vout'][vin['vout']]['value']) for vin in tx['vin'])
    outputs=sum(sats(vout['value']) for vout in tx['vout']);fee=inputs-outputs
    assert 0<fee<=10000,(txid,fee)
    return tx,{'txid':txid,'confirmations':tx['confirmations'],'feeSats':fee,'vsize':tx['vsize']}
assert fixture.rpc(48443,'getblockchaininfo')['chain']=='regtest'
assert int(fixture.rpc(48545,'eth_chainId'),16)==31337
mints=[]
for runtime in ['node','bare']:
    mints.extend([E['runtimes'][runtime]['old']['mint'],E['runtimes'][runtime]['upgrade']['pendingMint'],E['runtimes'][runtime]['upgrade']['freshImport']['mint'],E['ciDirectUpgrade']['runtimes'][runtime]['old']['mint']])
assert len({m['broadcast']['txid'] for m in mints})==8
mint_rows=[]
for m in mints:
    operation=m['prepared']['operationId'];saved=json.loads((ROOT/'issuer-state'/f'mint-{operation}.json').read_text());req=saved['request'];amount=req['amount'];lock_id=m['prepared']['lockId'];before=req['beforeBlock']
    _,bitcoin=chain_transaction(m['broadcast']['txid']);assert m['verified']['amount']==str(amount)
    record=call_uint(BRIDGE,'getFundsInBlock(uint256,uint256)(uint64)','0x'+lock_id,str(amount));assert record>0 and record-1<before
    receipt=fixture.rpc(48545,'eth_getTransactionReceipt',[m['paymentTxid']]);assert int(receipt['status'],16)==1
    assert record==int(receipt['blockNumber'],16)+1
    tx=fixture.rpc(48545,'eth_getTransactionByHash',[m['paymentTxid']]);assert tx['to'].lower()==BRIDGE.lower()
    expected=fixture.cast('calldata','fundsIn(uint256,uint256,uint64)',str(amount),'0x'+lock_id,str(before));assert tx['input'].lower()==expected.lower()
    depth=int(fixture.rpc(48545,'eth_blockNumber'),16)-int(receipt['blockNumber'],16);assert depth>=64
    mint_rows.append({'operationId':operation,'amount':str(amount),'bitcoin':bitcoin,'evmTransaction':m['paymentTxid'],'evmDepth':depth,'lockBlock':record-1,'beforeBlock':before,'exactLockCalldataMatched':True})
lock_total=sum(int(m['amount']) for m in mint_rows)
assert lock_total==20000000
assert call_uint(TOKEN,'balanceOf(address)(uint256)',BRIDGE)==lock_total
assert call_uint(BRIDGE,'circulatingSupply()(uint64)')==lock_total
burns=[]
for runtime in ['node','bare']:
    local=E['runtimes'][runtime];ci=E['ciDirectUpgrade']['runtimes'][runtime]
    burns.extend([(runtime,'wallet',local['old']['burn']['txid'],1000000,'11',local['old']['proofSha256']),
                  (runtime,'wallet',local['upgrade']['lostBurnResponse']['txid'],1000000,'22',local['upgrade']['lostBurnResponse']['proofSha256']),
                  (runtime,'ci-wallet',ci['old']['burn']['txid'],500000,'33',ci['old']['proofSha256']),
                  (runtime,'ci-wallet',ci['upgrade']['newBurn']['txid'],250000,'44',ci['upgrade']['newBurn']['proofSha256'])])
assert len({b[2] for b in burns})==8
burn_rows=[]
for runtime,directory,txid,amount,byte,expected_sha in burns:
    tx,bitcoin=chain_transaction(txid)
    candidates=[p for p in (OUT/runtime/directory).glob('*/transfers/'+txid+'/**/*') if p.is_file() and p.read_bytes()[:7]==b'RGB\0TFR']
    assert candidates,(runtime,txid)
    for p in candidates:assert sha(p.read_bytes())==expected_sha
    inspected=json.loads(subprocess.check_output([str(INSPECT),str(candidates[0]),txid],text=True))
    assert inspected['isTransfer'] and inspected['assetId']==AID and inspected['assetSchema']=='Bfa'
    assert len(inspected['witnesses'])==1
    witness=inspected['witnesses'][0];assert witness['txid']==txid and witness['closeMethod']=='opretFirst'
    opreturns=[v['scriptPubKey']['hex'] for v in tx['vout'] if v['scriptPubKey']['type']=='nulldata']
    assert opreturns and opreturns[0]=='6a20'+witness['commitmentHex']
    transitions=[t for o in witness['operations'] if o['assetId']==AID for t in o['transitions'] if t['type']=='Burn'];assert len(transitions)==1
    transition=transitions[0];assert not transition['outputs']
    burned=[g['BurnedAsset'] for g in transition['globals'] if isinstance(g,dict) and 'BurnedAsset' in g];assert burned==[amount]
    typehash=fixture.cast('keccak','UtexoBurnDestinationV1(uint64 destinationChainId,uint32 dstEid,bytes recipient)')
    recipienthash=fixture.cast('keccak','0x'+byte*20)
    preimage=fixture.cast('abi-encode','f(bytes32,uint64,uint32,bytes32)',typehash,'42161','0',recipienthash)
    commitment=fixture.cast('keccak',preimage).removeprefix('0x')
    reasons=[g['BurnReason'] for g in transition['globals'] if isinstance(g,dict) and 'BurnReason' in g];assert reasons==[commitment]
    burn_rows.append({'runtime':runtime,'wallet':directory,'amount':str(amount),'bitcoin':bitcoin,'proofSha256':expected_sha,'proofDecodedByOriginalUpstream':True,'proofMatchesConfirmedOpret':True,'destinationCommitment':commitment,'destinationComputedWithFoundry':True,'burnTransitionCount':1})
burn_total=sum(int(b['amount']) for b in burn_rows);assert burn_total==5500000
# The current SDK balances were read after both final CI transfer and restart phases.
balances={}
for runtime in ['node','bare']:
    last=E['finalAcceptance']['runtimes'][runtime]['newTransfer'];balances[runtime+'/wallet']=last['senderBalance'];balances[runtime+'/fresh-recipient']=last['recipientBalance'];balances[runtime+'/ci-wallet']=E['ciDirectUpgrade']['runtimes'][runtime]['upgrade']['newBurn']['remainingBalance']
assert E['ciDirectUpgrade']['pendingTransfers']['balancesAndOldBurnProofsPreservedAfterRestart']
held=sum(map(int,balances.values()));assert held==14500000 and lock_total-burn_total==held
result={'scope':'Read-only independent chain, proof and amount reconciliation after final CI pack execution.','assetId':AID,'bitcoinHeight':fixture.rpc(48443,'getblockcount'),'evmBlock':int(fixture.rpc(48545,'eth_blockNumber'),16),'mintCount':8,'mintedBaseUnits':str(lock_total),'confirmedBurnCount':8,'burnedBaseUnits':str(burn_total),'remainingWalletBaseUnits':str(held),'remainingWalletBalancesFromRestartChecks':balances,'tokenBalanceOfBridge':str(lock_total),'bridgeCirculatingSupply':str(lock_total),'mints':mint_rows,'burns':burn_rows,'proofInspector':{'rgbSource':'567e5b8308f70a6242137475394be5a82fc15c95','binarySha256':sha(INSPECT.read_bytes()),'sourceSha256':sha((ROOT/'issuer/src/bin/contract-inspect.rs').read_bytes())},'limitations':['No fundsOut redemption was submitted: the bridge retains backing for the 5.5 burned units, and its circulatingSupply remains 20 units.','Final remaining RGB balances come from actual SDK restart checks; this audit independently reconciles their sum against confirmed mint and burn proofs.','This is an isolated upstream MinimalBridge fixture, not hosted gateway/TEE or Play delivery testing.']}
(OUT/'financial-reconciliation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['mints','burns','remainingWalletBalancesFromRestartChecks']},indent=2))
