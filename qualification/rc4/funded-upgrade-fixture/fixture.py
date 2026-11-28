#!/usr/bin/env python3
"""Owned regtest/Anvil fixture. Never targets a configured or hosted wallet endpoint."""
import argparse,base64,hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
ISSUER=ROOT.parent/'upstream-upgrade-audit/target/debug/contract-upgrade-issuer-old'
ACCOUNT='0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
COMPOSE=['docker','compose','-f',str(ROOT/'compose.yaml')]

def persist(path,data):
    temporary=path.with_suffix('.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump(data,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def rpc(port,method,params=[],wallet=None):
    path='/wallet/'+wallet if wallet else '/'
    request=urllib.request.Request(f'http://127.0.0.1:{port}{path}',json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),{'Content-Type':'application/json'})
    if port==48443: request.add_header('Authorization','Basic '+base64.b64encode(b'user:default_password').decode())
    try:
        with urllib.request.urlopen(request,timeout=60) as response: result=json.load(response)
    except urllib.error.HTTPError as error: result=json.load(error)
    if result.get('error'): raise RuntimeError(result['error'])
    return result['result']

def mine(blocks=6):
    if 'miner' not in rpc(48443,'listwallets'): rpc(48443,'loadwallet',['miner'])
    address=rpc(48443,'getnewaddress',[],wallet='miner')
    return rpc(48443,'generatetoaddress',[blocks,address],wallet='miner')

def issuer(request):
    result=subprocess.run([str(ISSUER),str(ROOT/'issuer-state')],input=json.dumps(request),text=True,capture_output=True)
    if result.returncode: raise RuntimeError(result.stderr[-4000:])
    return json.loads(result.stdout)

def cast(*args):
    result=subprocess.run(COMPOSE+['exec','-T','anvil','cast',*args],check=True,text=True,capture_output=True)
    return result.stdout.strip()

def deploy(name,args):
    cmd=COMPOSE+['exec','-T','anvil','forge','create',f'/contracts/{name}.sol:{name}','--rpc-url','http://127.0.0.1:8545','--unlocked','--from',ACCOUNT,'--cache-path','/tmp/fixture-forge-cache','--out','/tmp/fixture-forge-out','--root','/tmp','--contracts','/contracts','--remappings=@openzeppelin/=/contracts/vendor/openzeppelin/','--broadcast','--json']
    if args: cmd+=['--constructor-args',*args]
    result=subprocess.run(cmd,text=True,capture_output=True)
    if result.returncode: raise RuntimeError(result.stderr[-5000:]+result.stdout[-5000:])
    start=result.stdout.rfind('{');data=json.loads(result.stdout[start:]);return data

def setup():
    p=ROOT/'deployment.json'
    if not p.exists():
        arb=deploy('MockArbSys',[])
        code=rpc(48545,'eth_getCode',[arb['deployedTo'],'latest'])
        rpc(48545,'anvil_setCode',['0x0000000000000000000000000000000000000064',code])
        token=deploy('TestERC20',['Fixture Dollar','FBUSD','6','1000000000000'])
        bridge=deploy('MinimalBridge',[token['deployedTo']])
        persist(p,{'rgbSource':'567e5b8308f70a6242137475394be5a82fc15c95','openzeppelinSource':'cab19933c33c2ad1d4c7a84864a3601dddfd16f3','mockArbSys':arb,'token':token,'bridge':bridge,'chainId':31337,'limitations':['Local upstream MinimalBridge fixture; no TEE signature verification and no hosted settlement qualification.']})
    d=json.loads(p.read_text())
    initialized=ROOT/'issuer-funded.json'
    if not initialized.exists():
        wallet=issuer({'command':'init'})
        txid=rpc(48443,'sendtoaddress',[wallet['address'],0.02],wallet='miner')
        mine(6);time.sleep(2)
        output=issuer({'command':'outputs'});mine(6);time.sleep(2)
        asset=issuer({'command':'issue','bridge':d['bridge']['deployedTo']})
        persist(initialized,{'fundingTxid':txid,'wallet':wallet,'outputs':output,'asset':asset})
    return json.loads(initialized.read_text())

def lock(request):
    """Request contains prepared operationId. Never automatically repeats an uncertain lock."""
    d=json.loads((ROOT/'deployment.json').read_text())
    p=ROOT/f"lock-{request['operationId']}.json"
    if p.exists():
        saved=json.loads(p.read_text())
        if saved['request']!=request: raise RuntimeError('lock request changed')
        if saved['state']=='submitted': return saved
        raise RuntimeError('uncertain lock requires receipt reconciliation, refusing replay')
    mint=json.loads((ROOT/'issuer-state'/f"mint-{request['operationId']}.json").read_text())
    if mint['state']!='prepared': raise RuntimeError('mint not durably prepared')
    amount=mint['request']['amount'];deadline=mint['request']['beforeBlock'];lock_id=mint['public']['lockId']
    bridge=d['bridge']['deployedTo'];token=d['token']['deployedTo']
    approval=cast('send',token,'approve(address,uint256)',bridge,str(amount),'--rpc-url','http://127.0.0.1:8545','--unlocked','--from',ACCOUNT,'--json')
    persist(p,{'request':request,'state':'submitting','approval':json.loads(approval),'mint':mint['public']})
    payment=cast('send',bridge,'fundsIn(uint256,uint256,uint64)',str(amount),'0x'+lock_id,str(deadline),'--rpc-url','http://127.0.0.1:8545','--unlocked','--from',ACCOUNT,'--json')
    record={'request':request,'state':'submitted','approval':json.loads(approval),'receipt':json.loads(payment),'mint':mint['public']}
    persist(p,record);rpc(48545,'anvil_mine',['0x40']);return record

def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['setup','issuer','mine','lock','status']);args=parser.parse_args()
    if args.command=='setup': value=setup()
    elif args.command=='issuer':value=issuer(json.load(sys.stdin))
    elif args.command=='mine':value=mine()
    elif args.command=='lock':value=lock(json.load(sys.stdin))
    else:value={'bitcoinHeight':rpc(48443,'getblockcount'),'evmBlock':int(rpc(48545,'eth_blockNumber'),16),'chainId':int(rpc(48545,'eth_chainId'),16)}
    print(json.dumps(value,indent=2))
if __name__=='__main__':main()
