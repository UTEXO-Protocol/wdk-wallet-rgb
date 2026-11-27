import assert from 'node:assert/strict'
import {spawn,spawnSync} from 'node:child_process'
import {createHash,randomBytes} from 'node:crypto'
import {mkdir,readFile,writeFile,rename,rm,readdir,stat,cp,chmod} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createInterface} from 'node:readline'
import {createConnection} from 'node:net'
const root=resolve(import.meta.dirname),base=resolve(root,'../baseline'),out=join(root,'packed-upgrade')
const oldConsumer=join(base,'packed-consumer'),oldNode=join(base,'artifacts/node-darwin-arm64/utexo-rgb-native'),bare=join(base,'sdk-source/node_modules/.bin/bare')
const [phase='old',newConsumer,newNode]=process.argv.slice(2)
const asset=JSON.parse(await readFile(join(root,'issuer-funded.json'),'utf8')).asset
const aid=asset.assetId
const digest=data=>createHash('sha256').update(data).digest('hex')
const evidence=join(out,'evidence.json'),privateFile=join(out,'private-state.json')
await mkdir(out,{recursive:true,mode:0o700})
async function save(path,value){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path)}
let state=await readFile(privateFile,'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return {assetId:aid,runtimes:{}}})
let report=await readFile(evidence,'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return {assetId:aid,scope:'Exact rc.3 packed SDK/native to rebuilt rc.4; local upstream MinimalBridge and regtest only.',runtimes:{}}})
function fixture(command,input){const r=spawnSync('python3',[join(root,'fixture.py'),command],{input:input?JSON.stringify(input):undefined,encoding:'utf8',maxBuffer:5*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
async function indexed(){return new Promise(resolveDone=>{const socket=createConnection({host:'127.0.0.1',port:48001});let all='';socket.setEncoding('utf8').setTimeout(2000);socket.once('connect',()=>socket.write(JSON.stringify({id:1,method:'blockchain.headers.subscribe',params:[]})+'\n'));socket.on('data',chunk=>{all+=chunk;if(all.includes('\n')){socket.destroy();try{resolveDone(JSON.parse(all.split('\n')[0]).result?.height)}catch{resolveDone(null)}}});socket.once('error',()=>resolveDone(null));socket.once('timeout',()=>socket.destroy());socket.once('close',()=>resolveDone(null))})}
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms))
async function wait(label,predicate){for(let i=0;i<40;i++){if(await predicate())return;await delay(500)}assert.fail('Timed out: '+label)}
async function mine(){fixture('mine');const {bitcoinHeight}=fixture('status');await wait('electrum height',async()=>await indexed()===bitcoinHeight)}
async function fund(address){const script="import fixture,json;print(json.dumps(fixture.rpc(48443,'sendtoaddress',["+JSON.stringify(address)+",0.02],wallet='miner')))";const r=spawnSync('python3',['-c',script],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);await mine();return JSON.parse(r.stdout)}
async function peer(runtime,consumer,worker){
 const file=join(consumer,'.upgrade-peer-'+randomBytes(6).toString('hex')+'.mjs');await writeFile(file,await readFile(join(root,'packed-peer.mjs')),{flag:'wx',mode:0o600})
 const nativeSha=digest(await readFile(runtime==='node'?worker:join(consumer,'node_modules/@utexo/wdk-wallet-rgb/prebuilds/darwin-arm64/utexo__wdk-wallet-rgb.bare')))
 const proc=spawn(runtime==='node'?process.execPath:bare,[file],{cwd:consumer,stdio:['pipe','pipe','pipe']});let id=0,pending,error,stderr='';proc.stderr.on('data',b=>{stderr+=b.toString();if(stderr.length>10000)stderr=stderr.slice(-10000)})
 function fail(e){error??=e;pending?.reject(error);pending=undefined}
 proc.on('error',fail);proc.stdin.on('error',fail)
 const exit=new Promise(yes=>proc.once('close',(code,signal)=>{fail(new Error('Peer exited: '+(signal??code)+' '+stderr));yes(code)}))
 const lines=createInterface({input:proc.stdout});lines.on('line',line=>{try{const reply=JSON.parse(line);assert.equal(reply.id,pending?.id);const p=pending;pending=undefined;reply.error?p.reject(Object.assign(new Error(reply.error.message),{code:reply.error.code})):p.resolve(reply.result)}catch(e){fail(e)}})
 async function request(method,args=[],params){if(error)throw error;assert.equal(pending,undefined);const timer=setTimeout(()=>{fail(new Error('Timeout: '+method));proc.kill()},180000);try{return await new Promise((yes,no)=>{pending={id:++id,resolve:yes,reject:no};proc.stdin.write(JSON.stringify({id,method,args,params})+'\n')})}finally{clearTimeout(timer)}}
 return {request,nativeSha,async open(data,name='wallet'){return request('open',[],{seed:data.seed,config:{network:'regtest',dataDir:join(out,runtime,name),indexerUrl:'tcp://127.0.0.1:48001',transportEndpoint:'rpc://127.0.0.1:48090/json-rpc',evmRpcUrls:{31337:'http://127.0.0.1:48545'},burnDestinationRoutes:[{chainId:'eip155:42161',dstEid:0}],maxFeeSats:'10000',...(runtime==='node'?{nativeExecutable:worker,nativeSha256:nativeSha}:{nativeSha256:nativeSha})}})},async stop(){try{if(!error)await request('stop')}finally{proc.stdin.end();const timer=setTimeout(()=>proc.kill('SIGKILL'),5000);try{assert.equal(await exit,0)}finally{clearTimeout(timer);lines.close();await rm(file)}}}}
}
async function balance(p,amount){await wait('BFA balance '+amount,async()=>{await p.request('refresh');let result;try{result=await p.request('getAssetBalance',[aid])}catch(e){if(e.code==='ASSET_NOT_FOUND')return false;throw e}return result.spendable===amount&&result.settled===amount})}
async function mint(p,runtime,invoice,amount,label){
 const operationId='upgrade-'+runtime+'-'+label
 const beforeBlock=fixture('status').evmBlock+256
 const prepared=fixture('issuer',{command:'mint-begin',operationId,assetId:aid,invoice:invoice.invoice,amount:Number(amount),beforeBlock})
 let mint
 await wait('verified mint before payment',async()=>{await p.request('refresh');mint=await p.request('getReceivedMintForInvoice',[{invoice:invoice.invoice,expectedAssetId:aid}]);return mint!==null})
 assert.equal(mint.opid,prepared.opid);assert.equal(mint.lockId,prepared.lockId);assert.equal(mint.txid,prepared.txid);assert.equal(mint.amount,amount)
 const payment=fixture('lock',{operationId})
 const broadcast=fixture('issuer',{command:'mint-end',operationId});assert.equal(broadcast.txid,prepared.txid)
 await mine();await p.request('refresh');fixture('issuer',{command:'refresh'})
 return {prepared,paymentTxid:payment.receipt.transactionHash,broadcast,verified:mint}
}
function receiveParams(runtime,kind,includeAsset=false){return {method:kind==='blind'?'blindReceive':'witnessReceive',operationId:'upgrade-'+runtime+'-'+kind+'-receive-pending',requestKey:digest(runtime+kind),expectedAssetId:aid,options:{...(includeAsset&&{assetId:aid}),amount:'1000000',expirationSeconds:86400,minConfirmations:6}}}
async function exportContract(){const todo=[join(root,'issuer-state/wallet')];while(todo.length){const dir=todo.pop();for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){todo.push(path);continue}if(!entry.name.startsWith('consignment'))continue;const bytes=await readFile(path);if(bytes.subarray(0,7).equals(Buffer.from('RGB\0TFR'))){const output=join(root,'public-busdt-contract.rgb');fixture('issuer',{command:'export-contract-from-transfer',transferPath:path,outputPath:output});const contract=await readFile(output);return {path:output,sha256:digest(contract),byteLength:contract.length,assetId:aid}}}}throw new Error('Cannot locate minted consignment')}
if(phase==='old'){
 for(const runtime of ['node','bare']){
  assert(!state.runtimes[runtime]?.complete,'Old qualification already exists; do not replay financial operations')
  const data=state.runtimes[runtime]??={seed:[...randomBytes(64)]};await save(privateFile,state)
  const p=await peer(runtime,oldConsumer,oldNode)
  try{
   await p.open(data);await p.request('instrument')
   data.keys??=await p.request('getPublicKeys');data.address??=await p.request('getAddress');if(!data.funding){data.funding=await fund(data.address);await save(privateFile,state)}
   if(!data.outputs){data.outputs=await p.request('createUtxos',[{operationId:'upgrade-'+runtime+'-initial-outputs',count:12,size:'10000',feeRate:'2'}]);await save(privateFile,state);await mine()}await p.request('refresh')
   data.invoice??=await p.request('trustedReceive',[],{method:'witnessReceive',operationId:'upgrade-'+runtime+'-mint-receive-current',requestKey:digest(runtime+'mint'),expectedAssetId:aid,options:{amount:'6000000',expirationSeconds:86400,minConfirmations:6}})
   await save(privateFile,state)
   data.mint??=await mint(p,runtime,data.invoice,'6000000','initial-mint-v3');await save(privateFile,state);await balance(p,'6000000')
   data.pending={}
   for(const kind of ['witness','blind'])data.pending[kind]=await p.request('trustedReceive',[],receiveParams(runtime,kind))
   const burnReq={operationId:'upgrade-'+runtime+'-existing-burn-proof',assetId:aid,amount:'1000000',feeRate:'2',minConfirmations:6,burnRecipient:{chainId:'eip155:42161',address:'0x1111111111111111111111111111111111111111'}}
   data.burn=await p.request('burn',[],burnReq);await mine();await balance(p,'5000000')
   data.proof=await p.request('getConsignment',[{assetId:aid,txid:data.burn.txid}]);data.recovered=await p.request('recoverBurn',[burnReq.operationId]);assert.deepEqual(data.recovered.proof,data.proof)
   data.balance=await p.request('getAssetBalance',[aid]);data.transfers=await p.request('listTransfers');data.btc=await p.request('getBtcBalance');data.instrumentation=await p.request('instrumentation')
   data.complete=true;await save(privateFile,state)
   report.runtimes[runtime]={old:{version:'3.0.0-rc.3',nativeSha256:p.nativeSha,address:data.address,outputs:data.outputs,mint:data.mint,balance:data.balance,burn:data.burn,proofSha256:digest(Buffer.from(data.proof.data,'base64')),pendingInvoices:data.pending,transferCount:data.transfers.length,complete:true}}
   await save(evidence,report)
  }finally{await p.stop()}
  await cp(join(out,runtime,'wallet'),join(out,runtime,'old-reference'),{recursive:true,preserveTimestamps:true,errorOnExist:true,force:false});await chmod(join(out,runtime,'old-reference'),0o700)
  console.log(runtime+' rc.3 funded mint/burn + pending invoices complete')
 }
 report.contract=await exportContract();await save(evidence,report)
 } else if(phase==='ci-old') {
 state.ciRuntimes??={};report.ciDirectUpgrade??={runtimes:{}}
 for(const runtime of ['node','bare']){
  assert(!state.ciRuntimes[runtime]?.complete,'CI old baseline already completed; do not replay')
  const data=state.ciRuntimes[runtime]??={seed:[...randomBytes(64)]};await save(privateFile,state)
  const p=await peer(runtime,oldConsumer,oldNode)
  try{
   await p.open(data,'ci-wallet');data.keys=await p.request('getPublicKeys');data.signingAddress=await p.request('getMessageSigningAddress');data.address=await p.request('getAddress')
   data.funding=await fund(data.address);data.outputs=await p.request('createUtxos',[{operationId:'ci-'+runtime+'-initial-rgb-outputs',count:8,size:'10000',feeRate:'2'}]);await mine();await p.request('refresh')
   data.invoice=await p.request('trustedReceive',[],{method:'witnessReceive',operationId:'ci-'+runtime+'-initial-mint-invoice',requestKey:digest('ci-mint-'+runtime),expectedAssetId:aid,options:{amount:'2000000',expirationSeconds:86400,minConfirmations:6}})
   await save(privateFile,state)
   data.mint=await mint(p,'ci-'+runtime,data.invoice,'2000000','before-direct-ci-upgrade');await balance(p,'2000000')
   data.pendingRequest={method:'blindReceive',operationId:'ci-'+runtime+'-pending-generic-invoice',requestKey:digest('ci-pending-'+runtime),expectedAssetId:aid,options:{amount:'1000000',expirationSeconds:86400,minConfirmations:6}}
   data.pending=await p.request('trustedReceive',[],data.pendingRequest)
   data.burnId='ci-'+runtime+'-old-burn-before-upgrade'
   data.burn=await p.request('burn',[],{operationId:data.burnId,assetId:aid,amount:'500000',feeRate:'2',minConfirmations:6,burnRecipient:{chainId:'eip155:42161',address:'0x3333333333333333333333333333333333333333'}});await mine();await balance(p,'1500000')
   data.proof=await p.request('getConsignment',[{assetId:aid,txid:data.burn.txid}]);data.recovery=await p.request('recoverBurn',[data.burnId]);assert.deepEqual(data.recovery.proof,data.proof)
   data.btc=await p.request('getBtcBalance');data.balance=await p.request('getAssetBalance',[aid]);data.transfers=await p.request('listTransfers');data.complete=true;await save(privateFile,state)
   report.ciDirectUpgrade.runtimes[runtime]={old:{version:'3.0.0-rc.3',nativeSha256:p.nativeSha,funding:data.funding,outputs:data.outputs,mint:data.mint,burn:data.burn,balance:data.balance,proofSha256:digest(Buffer.from(data.proof.data,'base64')),pendingInvoice:data.pending,complete:true}}
   await save(evidence,report);console.log(runtime+' fresh exact rc.3 funded baseline ready for direct final CI upgrade')
  }finally{await p.stop()}
 }
 } else if(phase==='ci-old-ordinary') {
 for(const runtime of ['node','bare']){
  const data=state.ciRuntimes[runtime];assert(data.complete&&!data.upgraded,'Only existing old CI wallets may be prepared')
  const p=await peer(runtime,oldConsumer,oldNode)
  try{
   await p.open(data,'ci-wallet');data.ordinary??=[]
   for(const schema of ['Nia','Cfa']){
    if(data.ordinary.some(a=>a.schema===schema))continue
    const issued=await p.request('issueAsset'+schema,[{operationId:'ci-'+runtime+'-old-issue-'+schema.toLowerCase(),name:'Existing '+schema+' Upgrade',...(schema==='Nia'&&{ticker:'VTEST'}),precision:2,amounts:['1000']}])
    data.ordinary.push({schema,assetId:issued.assetId,amount:'1000'});await save(privateFile,state)
   }
   data.assets=await p.request('listAssets');data.transfers=await p.request('listTransfers');data.btc=await p.request('getBtcBalance');await save(privateFile,state)
   report.ciDirectUpgrade.runtimes[runtime].old.ordinary=data.ordinary;report.ciDirectUpgrade.runtimes[runtime].old.assetMetadata=data.assets;await save(evidence,report)
   console.log(runtime+' rc.3 NIA/CFA stock and metadata prepared as direct CI upgrade control group')
  }finally{await p.stop()}
 }
 } else if(phase==='ci-new') {
 assert(newConsumer&&newNode,'ci-new requires exact installed final pack and CI Node worker')
 for(const runtime of ['node','bare']){
  const data=state.ciRuntimes[runtime];assert(data.complete&&!data.upgraded,'CI old baseline must be complete and not upgraded')
  const p=await peer(runtime,resolve(newConsumer),resolve(newNode))
  const result={nativeSha256:p.nativeSha,version:JSON.parse(await readFile(join(newConsumer,'node_modules/@utexo/wdk-wallet-rgb/package.json'),'utf8')).version}
  try{
   await p.open(data,'ci-wallet');await p.request('instrument')
   assert.deepEqual(await p.request('getPublicKeys'),data.keys);assert.equal(await p.request('getMessageSigningAddress'),data.signingAddress)
   assert.deepEqual(await p.request('getBtcBalance'),data.btc);assert.deepEqual(await p.request('getAssetBalance',[aid]),data.balance);if(data.assets)assert.deepEqual(await p.request('listAssets'),data.assets,'Existing BFA/NIA/CFA asset metadata must survive')
   const transfers=await p.request('listTransfers');const stable=rows=>rows.map(({idx,batchTransferIdx,status,kind,txid,recipientId,assignments})=>({idx,batchTransferIdx,status,kind,txid,recipientId,assignments}));assert.deepEqual(stable(transfers),stable(data.transfers));assert.deepEqual(transfers,data.transfers,'All previous transfer fields and timestamps must survive direct CI upgrade')
   assert.deepEqual(await p.request('getConsignment',[{assetId:aid,txid:data.burn.txid}]),data.proof);assert.deepEqual(await p.request('recoverBurn',[data.burnId]),data.recovery)
   const journal=join(out,runtime,'ci-wallet/.wdk-onchain-invoices-v1',data.pendingRequest.operationId+'.json');const before=await readFile(journal)
   assert.deepEqual(await p.request('trustedReceive',[],{...data.pendingRequest,options:{...data.pendingRequest.options,assetId:aid}}),data.pending)
   assert.deepEqual(await readFile(journal),before);const calls=await p.request('instrumentation');assert(!calls.calls.includes('blindReceive'));assert.equal(calls.reviews.length,0)
   const contract=Buffer.from((await p.request('export',[aid])).base64,'base64');assert.equal(digest(contract),report.contract.sha256)
   const message='Direct final CI update '+runtime,sig=await p.request('signMessageBip322',[message,data.signingAddress]);assert.equal(await p.request('verifyMessageBip322',[message,data.signingAddress,sig]),true)
   const burn={operationId:'ci-'+runtime+'-new-burn-response-loss',assetId:aid,amount:'250000',feeRate:'2',minConfirmations:6,burnRecipient:{chainId:'eip155:42161',address:'0x4444444444444444444444444444444444444444'}}
   await p.request('close');await p.open(data,'ci-wallet');await p.request('instrument',[],{loseOperation:'burnEnd'})
   await assert.rejects(p.request('burn',[],burn),{code:'NATIVE_CLOSED'});await p.request('close');await p.open(data,'ci-wallet')
   const recovered=await p.request('recoverBurn',[burn.operationId]);assert.deepEqual(await p.request('recoverBurn',[burn.operationId]),recovered);await assert.rejects(p.request('burn',[],burn),{code:'OPERATION_EXISTS'})
   await mine();await balance(p,'1250000');await p.request('close');await p.open(data,'ci-wallet')
   assert.deepEqual(await p.request('recoverBurn',[burn.operationId]),recovered);assert.deepEqual(await p.request('recoverBurn',[data.burnId]),data.recovery)
   assert.equal((await p.request('instrumentation')).calls.filter(c=>c==='burnEnd').length,1)
   Object.assign(result,{directFromExactRc3:true,retainedAccountKeys:true,retainedMessageAddress:true,retainedBtc:true,retainedBfa:true,retainedTransferIdentities:true,retainedOrdinaryAssetMetadata:data.ordinary??[],oldProofSha256:digest(Buffer.from(data.proof.data,'base64')),oldProofRecoveryUnchanged:true,pendingBlindedJournalUnchanged:true,noReceiveReallocation:true,noRepeatedApproval:true,contractExportSha256:digest(contract),bip322Verified:true,newBurn:{txid:recovered.txid,amount:'250000',proofSha256:digest(Buffer.from(recovered.proof.data,'base64')),lostEndReply:true,recoveredTwice:true,recoveredAfterRestart:true,duplicateRejected:true,burnEndCalls:1,remainingBalance:'1250000'},complete:true})
   data.upgraded=true;await save(privateFile,state);report.ciDirectUpgrade.runtimes[runtime].upgrade=result;await save(evidence,report);console.log(runtime+' direct exact rc.3→final CI rc.4 funded upgrade passed')
  }finally{await p.stop()}
 }
 } else if(phase==='ci-pending') {
 assert(newConsumer&&newNode,'ci-pending requires final installed pack + CI Node worker')
 assert(!report.ciDirectUpgrade.pendingTransfers,'Old pending invoice delivery already tested; do not replay')
 const peers={node:await peer('node',resolve(newConsumer),resolve(newNode)),bare:await peer('bare',resolve(newConsumer),resolve(newNode))}
 const rows=[]
 try {
  for(const runtime of ['node','bare']){assert(state.ciRuntimes[runtime].upgraded);await peers[runtime].open(state.ciRuntimes[runtime],'ci-wallet')}
  for(const [from,to] of [['node','bare'],['bare','node']]){
   const invoice=state.ciRuntimes[to].pending
   const sent=await peers[from].request('sendRgbInvoice',[{operationId:'ci-'+from+'-to-'+to+'-old-pending',assetId:aid,invoice:invoice.invoice,amount:'1000000',feeRate:'2',minConfirmations:6}])
   await wait('delivery to original blinded recipient',async()=>{await peers[to].request('refresh');await peers[from].request('refresh');const r=spawnSync('python3',['-c',"import fixture,json;print(json.dumps(fixture.rpc(48443,'getrawmempool')))"],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).includes(sent.txid)})
   await mine();await peers[to].request('refresh');await peers[from].request('refresh')
   const received=await peers[to].request('getInvoiceStatus',[invoice.recipientId]);assert.equal(received.status,'Settled');assert.equal(received.txid,sent.txid)
   rows.push({from,to,txid:sent.txid,amount:'1000000',originalRecipientId:invoice.recipientId,status:received.status})
  }
  for(const runtime of ['node','bare']){assert.equal((await peers[runtime].request('getAssetBalance',[aid])).spendable,'1250000');await peers[runtime].request('close');await peers[runtime].open(state.ciRuntimes[runtime],'ci-wallet');assert.equal((await peers[runtime].request('getAssetBalance',[aid])).spendable,'1250000');assert.deepEqual(await peers[runtime].request('recoverBurn',[state.ciRuntimes[runtime].burnId]),state.ciRuntimes[runtime].recovery)}
  report.ciDirectUpgrade.pendingTransfers={rows,bothOriginalOldBlindedRecipientsReceived:true,privateRecipientKeysSurvived:true,balancesAndOldBurnProofsPreservedAfterRestart:true};await save(evidence,report)
  console.log('Both exact final CI runtimes received real BFA sends to original rc.3 blinded invoices after upgrade')
 }finally{await peers.node.stop();await peers.bare.stop()}
 } else if(phase==='final') {
 assert(newConsumer&&newNode,'final requires exact installed complete pack + CI Node worker')
 const finalPkg=join(newConsumer,'node_modules/@utexo/wdk-wallet-rgb')
 const localPkg=join(out,'new-consumer/node_modules/@utexo/wdk-wallet-rgb')
 const runtimePaths=['index.js','bare.js','onchain.d.ts']
 for(const file of await readdir(join(localPkg,'src')))if(file.endsWith('.js'))runtimePaths.push('src/'+file)
 const compared=[]
 for(const file of runtimePaths){const old=await readFile(join(localPkg,file)).catch(e=>{if(e.code!=='ENOENT')throw e;return undefined});if(old===undefined)continue;assert.deepEqual(await readFile(join(finalPkg,file)),old,'Final runtime source changed: '+file);compared.push(file)}
 const finalManifest=JSON.parse(await readFile(join(finalPkg,'src/onchain-bare-native.json'),'utf8'))
 const localManifest=JSON.parse(await readFile(join(localPkg,'src/onchain-bare-native.json'),'utf8'))
 for(const key of ['source','overlayTree','integrationTree','protocol','releaseHold'])assert.deepEqual(finalManifest[key],localManifest[key])
 report.finalAcceptance={runtimeFilesEqualLocalQualification:compared,nativeSource:finalManifest.source,nativeTree:finalManifest.integrationTree,runtimes:{}}
 const sandbox=JSON.parse(await readFile(resolve(root,'../../iris-contract-import/src/integrations/wdk/config/sandbox-signet-profile.json'),'utf8'))
 async function settleFinal(sender,receiver,txid){await wait('final RGB broadcast',async()=>{await receiver.request('refresh');await sender.request('refresh');const r=spawnSync('python3',['-c',"import fixture,json;print(json.dumps(fixture.rpc(48443,'getrawmempool')))"],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).includes(txid)});await mine();await receiver.request('refresh');await sender.request('refresh')}
 for(const runtime of ['node','bare']){
  const data=state.runtimes[runtime];assert(data.upgraded,'Local actual upgrade incomplete')
  const p=await peer(runtime,resolve(newConsumer),resolve(newNode)),receiver=await peer(runtime,resolve(newConsumer),resolve(newNode))
  const suffix=p.nativeSha.slice(0,12)
  assert(!data.finalAccepted,'Final funded acceptance already completed; do not replay')
  try {
   await p.open(data);await receiver.open(data.fresh,'fresh-recipient');await p.request('instrument')
   assert.deepEqual(await p.request('getPublicKeys'),data.keys)
   assert.deepEqual(await p.request('getConsignment',[{assetId:aid,txid:data.burn.txid}]),data.proof)
   assert.deepEqual(await p.request('recoverBurn',['upgrade-'+runtime+'-existing-burn-proof']),data.recovered)
   assert.deepEqual(await p.request('recoverBurn',['upgrade-'+runtime+'-lost-native-burn-end']),data.newBurn)
   assert.deepEqual(await p.request('trustedReceive',[],receiveParams(runtime,'blind',true)),data.pending.blind)
   assert.equal((await p.request('getAssetBalance',[aid])).spendable,'4500000');assert.equal((await receiver.request('getAssetBalance',[aid])).spendable,'1500000')
   const message='Final complete pack '+runtime+' '+suffix,signingAddress=await p.request('getMessageSigningAddress')
   const signature=await p.request('signMessageBip322',[message,signingAddress]);assert.equal(await p.request('verifyMessageBip322',[message,signingAddress,signature]),true)
   const contract=Buffer.from((await p.request('export',[aid])).base64,'base64');assert.equal(digest(contract),report.contract.sha256)
   const inv=await receiver.request('witnessReceive',[{assetId:aid,amount:'10000',expirationSeconds:86400,minConfirmations:6}])
   const operationId='final-'+runtime+'-bfa-'+suffix
   const sent=await p.request('sendRgbInvoice',[{operationId,assetId:aid,invoice:inv.invoice,amount:'10000',feeRate:'2',minConfirmations:6,witnessAmountSats:'1000'}])
   await settleFinal(p,receiver,sent.txid)
   assert.equal((await p.request('getAssetBalance',[aid])).spendable,'4490000');assert.equal((await receiver.request('getAssetBalance',[aid])).spendable,'1510000')
   await assert.rejects(p.request('sendRgbInvoice',[{operationId,assetId:aid,invoice:inv.invoice,amount:'10000',feeRate:'2',minConfirmations:6,witnessAmountSats:'1000'}]),{code:'OPERATION_EXISTS'})
   await p.request('close');await receiver.request('close');await p.open(data);await receiver.open(data.fresh,'fresh-recipient')
   assert.equal((await p.request('getAssetBalance',[aid])).spendable,'4490000');assert.equal((await receiver.request('getAssetBalance',[aid])).spendable,'1510000');assert.equal((await p.request('recoverSend',[operationId])).txid,sent.txid)
   assert.deepEqual(await p.request('recoverBurn',['upgrade-'+runtime+'-existing-burn-proof']),data.recovered)
   await receiver.request('close')
   await receiver.request('open',[],{seed:[...randomBytes(64)],config:{startupMode:'offline',network:'signet',profile:'staging',mode:'rgb',dataDir:join(out,runtime,'final-sandbox-'+suffix),indexerUrl:sandbox.indexerUrl,transportEndpoint:sandbox.proxyEndpoint,evmRpcUrls:{42161:sandbox.arbitrumRpcEndpoint},maxFeeSats:'10000',...(runtime==='node'?{nativeExecutable:resolve(newNode),nativeSha256:p.nativeSha}:{nativeSha256:p.nativeSha})}})
   const sandboxRequest={assetId:sandbox.busdt.assetId,sha256:sandbox.busdt.artifact.sha256,contract:sandbox.busdt.artifact.contractBase64}
   assert.deepEqual(await receiver.request('register',[],sandboxRequest),{assetId:sandbox.busdt.assetId})
   const [metadata]=await receiver.request('listAssets');assert.equal(metadata.name,sandbox.busdt.nativeName);assert.equal(metadata.ticker,sandbox.busdt.nativeTicker);assert.equal(metadata.precision,sandbox.busdt.precision)
   assert.equal(digest(Buffer.from((await receiver.request('export',[sandbox.busdt.assetId])).base64,'base64')),sandbox.busdt.artifact.sha256);assert.equal(await receiver.request('getConnectionStatus'),'offline')
   report.finalAcceptance.runtimes[runtime]={nativeSha256:p.nativeSha,retainedAccountKeys:true,oldRc3BurnProofUnchanged:true,lostBurnReplyRecoveryUnchanged:true,pendingBlindedInvoiceUnchanged:true,bip322Verified:true,newTransfer:{txid:sent.txid,amount:'10000',senderBalance:'4490000',recipientBalance:'1510000',recoveredAfterRestart:true,duplicateRejected:true},sandboxOffline:{assetId:metadata.assetId,sha256:sandbox.busdt.artifact.sha256,metadataMatches:true,noOnlineSession:true},complete:true}
   data.finalAccepted=true;await save(privateFile,state);await save(evidence,report)
   console.log(runtime+' final exact pack + CI native acceptance passed')
  }finally{await receiver.stop();await p.stop()}
 }
 } else {
 assert.equal(phase,'new');assert(newConsumer&&newNode,'new requires packed consumer + native worker')
 const contract=await readFile(report.contract.path)
 assert.equal(digest(contract),report.contract.sha256)
 const sandbox=JSON.parse(await readFile(resolve(root,'../../iris-contract-import/src/integrations/wdk/config/sandbox-signet-profile.json'),'utf8'))
 const sandboxContract=Buffer.from(sandbox.busdt.artifact.contractBase64,'base64')
 assert.equal(digest(sandboxContract),sandbox.busdt.artifact.sha256);assert.equal(sandboxContract.length,648)
 report.sandboxOffline??={}
 for(const runtime of ['node','bare']){
  if(report.sandboxOffline[runtime])continue
  const p=await peer(runtime,resolve(newConsumer),resolve(newNode))
  const openParams={seed:[...randomBytes(64)],config:{startupMode:'offline',network:'signet',profile:'staging',mode:'rgb',dataDir:join(out,runtime,'sandbox-offline'),indexerUrl:sandbox.indexerUrl,transportEndpoint:sandbox.proxyEndpoint,evmRpcUrls:{42161:sandbox.arbitrumRpcEndpoint},maxFeeSats:'10000',...(runtime==='node'?{nativeExecutable:resolve(newNode),nativeSha256:p.nativeSha}:{nativeSha256:p.nativeSha})}}
  try {
   await p.request('instrument');await p.request('open',[],openParams)
   assert.equal(await p.request('getConnectionStatus'),'offline')
   assert.deepEqual(await p.request('listAssets'),[])
   await assert.rejects(p.request('register',[],{assetId:aid,sha256:report.contract.sha256,contract:contract.toString('base64')}),{code:'CONTRACT_INVALID'})
   assert.deepEqual(await p.request('listAssets'),[])
   await assert.rejects(p.request('register',[],{assetId:aid,sha256:sandbox.busdt.artifact.sha256,contract:sandboxContract.toString('base64')}),{code:'CONTRACT_ASSET_MISMATCH'})
   assert.deepEqual(await p.request('listAssets'),[])
   const params={assetId:sandbox.busdt.assetId,sha256:sandbox.busdt.artifact.sha256,contract:sandboxContract.toString('base64')}
   assert.deepEqual(await p.request('register',[],params),{assetId:sandbox.busdt.assetId})
   const [registered]=await p.request('listAssets')
   assert.equal(registered.name,sandbox.busdt.nativeName);assert.equal(registered.ticker,sandbox.busdt.nativeTicker);assert.equal(registered.precision,sandbox.busdt.precision);assert.equal(registered.schema,'Bfa');assert.deepEqual(registered.balance,{settled:'0',future:'0',spendable:'0'})
   assert.equal(digest(Buffer.from((await p.request('export',[sandbox.busdt.assetId])).base64,'base64')),sandbox.busdt.artifact.sha256)
   await assert.rejects(p.request('register',[],params),{code:'ASSET_ALREADY_KNOWN'})
   await p.request('close');await p.request('open',[],openParams)
   assert.deepEqual(await p.request('listAssets'),[registered])
   assert.equal(await p.request('getConnectionStatus'),'offline')
   const instrumentation=await p.request('instrumentation')
   assert(!instrumentation.calls.includes('goOnline'))
   report.sandboxOffline[runtime]={assetId:registered.assetId,sha256:sandbox.busdt.artifact.sha256,byteLength:648,name:registered.name,ticker:registered.ticker,precision:registered.precision,noOnlineSession:true,wrongChainRejected:true,wrongIdRejected:true,duplicateRejected:true,zeroBalance:true,restartPreserved:true}
   await save(evidence,report)
  }finally{await p.stop()}
 }

 async function mempool(){const r=spawnSync('python3',['-c',"import fixture,json;print(json.dumps(fixture.rpc(48443,'getrawmempool')))"],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
 async function settle(sender,recipient,txid){await wait('RGB transfer broadcast',async()=>{await recipient.request('refresh');await sender.request('refresh');return(await mempool()).includes(txid)});await mine();await recipient.request('refresh');await sender.request('refresh')}
 async function expectedBalance(p,assetId,amount){await wait('asset balance '+amount,async()=>{await p.request('refresh');return(await p.request('getAssetBalance',[assetId])).spendable===amount})}
 for(const runtime of ['node','bare']) {
  const data=state.runtimes[runtime];assert(data.complete,'Old baseline incomplete')
  assert(!data.upgraded,'Upgrade already completed; refuse duplicate funded operations')
  if(!data.addressReference){
   const reference=await peer(runtime,oldConsumer,oldNode)
   try{await reference.open(data,'old-reference');data.addressReference={first:await reference.request('getAddress'),second:await reference.request('getNewAddress'),signing:await reference.request('getMessageSigningAddress')};await save(privateFile,state)}finally{await reference.stop()}
  }
  const p=await peer(runtime,resolve(newConsumer),resolve(newNode))
  let recipient
  const result={nativeSha256:p.nativeSha,scope:'Actual installed pack, persistent old wallet data; local chain settlement only.'}
  try {
   await p.open(data);await p.request('instrument')
   const version=JSON.parse(await readFile(join(newConsumer,'node_modules/@utexo/wdk-wallet-rgb/package.json'),'utf8')).version
   result.version=version
   assert.deepEqual(await p.request('getPublicKeys'),data.keys)
   if(data.firstAddressBeforeHarnessCorrection)assert.equal(data.addressReference.first,data.firstAddressBeforeHarnessCorrection);const nextAddress=await p.request('getAddress');assert.equal(nextAddress,data.addressCallsBeforeTest===1?data.addressReference.second:data.addressReference.first);assert.equal(await p.request('getMessageSigningAddress'),data.addressReference.signing)
   assert.deepEqual(await p.request('getAssetBalance',[aid]),data.balance)
   assert.deepEqual(await p.request('getBtcBalance'),data.btc)
   const transfers=await p.request('listTransfers')
   const identities=rows=>rows.map(({idx,batchTransferIdx,status,kind,txid,recipientId,assignments})=>({idx,batchTransferIdx,status,kind,txid,recipientId,assignments}))
   assert.deepEqual(identities(transfers),identities(data.transfers))
   assert.deepEqual(await p.request('getConsignment',[{assetId:aid,txid:data.burn.txid}]),data.proof)
   assert.deepEqual(await p.request('recoverBurn',['upgrade-'+runtime+'-existing-burn-proof']),data.recovered)
   const exported=Buffer.from((await p.request('export',[aid])).base64,'base64')
   assert.equal(digest(exported),report.contract.sha256)
   result.retained={addressSequenceMatchesOldRuntime:true,nextAddress,publicKeys:true,btcBalance:true,bfaBalance:true,transfers:true,burnProof:true,burnRecovery:true,exportSha256:digest(exported)}
   const pending=[]
   for(const kind of ['witness','blind']) {
    const journal=join(out,runtime,'wallet/.wdk-onchain-invoices-v1',receiveParams(runtime,kind).operationId+'.json')
    const before=await readFile(journal)
    const countsBefore=await p.request('instrumentation')
    assert.deepEqual(await p.request('trustedReceive',[],receiveParams(runtime,kind,true)),data.pending[kind])
    assert.equal(digest(await readFile(journal)),digest(before),'Retried receive must not rewrite journal')
    const countsAfter=await p.request('instrumentation')
    assert.equal(countsAfter.calls.filter(c=>c==='blindReceive'||c==='witnessReceive').length,countsBefore.calls.filter(c=>c==='blindReceive'||c==='witnessReceive').length)
    assert.equal(countsAfter.reviews.length,countsBefore.reviews.length)
    pending.push({kind,identicalInvoice:true,unchangedJournal:true,noNativeAllocation:true,noRepeatedApproval:true})
   }
   result.pendingRecovery=pending
   report.runtimes[runtime].upgrade=result;await save(evidence,report)
   // The original generic witness invoice remains usable after the native schema upgrade.
   result.pendingMint=await mint(p,runtime,data.pending.witness,'1000000','upgraded-pending-mint')
   await balance(p,'6000000')
   const message='Contract import upgrade qualification '+runtime
   const signingAddress=await p.request('getMessageSigningAddress')
   const signature=await p.request('signMessageBip322',[message,signingAddress])
   assert.equal(await p.request('verifyMessageBip322',[message,signingAddress,signature]),true)
   result.bip322={address:signingAddress,verified:true}
   await p.request('close');await p.open(data)
   assert.equal(await p.request('verifyMessageBip322',[message,signingAddress,signature]),true)
   result.restartVerified=true
   // Drop the actual successful native burnEnd response, not a fabricated JS return value.
   const lostBurn={operationId:'upgrade-'+runtime+'-lost-native-burn-end',assetId:aid,amount:'1000000',feeRate:'2',minConfirmations:6,burnRecipient:{chainId:'eip155:42161',address:'0x2222222222222222222222222222222222222222'}}
   await p.request('instrument',[],{loseOperation:'burnEnd'})
   await assert.rejects(p.request('burn',[],lostBurn),{code:'NATIVE_CLOSED'})
   await p.request('close');await p.open(data)
   const recovered=await p.request('recoverBurn',[lostBurn.operationId])
   const recoveredAgain=await p.request('recoverBurn',[lostBurn.operationId]);assert.deepEqual(recoveredAgain,recovered)
   await assert.rejects(p.request('burn',[],lostBurn),{code:'OPERATION_EXISTS'})
   await mine();await balance(p,'5000000')
   assert.deepEqual(await p.request('getConsignment',[{assetId:aid,txid:recovered.txid}]),recovered.proof)
   await p.request('close');await p.open(data)
   assert.deepEqual(await p.request('recoverBurn',[lostBurn.operationId]),recovered)
   result.lostBurnResponse={txid:recovered.txid,proofSha256:digest(Buffer.from(recovered.proof.data,'base64')),recoverTwice:true,recoverAfterRestart:true,duplicateRejected:true,burnEndCalls:(await p.request('instrumentation')).calls.filter(c=>c==='burnEnd').length}
   assert.equal(result.lostBurnResponse.burnEndCalls,1)
   data.newBurn=recovered
   // Fresh wallet registers and exports the genuine old-issued BFA before receiving it.
   data.fresh={seed:[...randomBytes(64)]};await save(privateFile,state)
   recipient=await peer(runtime,resolve(newConsumer),resolve(newNode));await recipient.open(data.fresh,'fresh-recipient')
   const freshAddress=await recipient.request('getAddress');const freshFunding=await fund(freshAddress)
   const freshOutputs=await recipient.request('createUtxos',[{operationId:'upgrade-'+runtime+'-fresh-rgb-outputs',count:8,size:'10000',feeRate:'2'}]);await mine();await recipient.request('refresh')
   assert.equal((await recipient.request('getCapabilities')).contractRegistration.status,'available')
   const importRequest={assetId:aid,sha256:report.contract.sha256,contract:contract.toString('base64')}
   assert.deepEqual(await recipient.request('register',[],importRequest),{assetId:aid})
   assert.deepEqual((await recipient.request('listAssets')).map(a=>a.assetId),[aid])
   assert.equal(digest(Buffer.from((await recipient.request('export',[aid])).base64,'base64')),report.contract.sha256)
   await assert.rejects(recipient.request('register',[],importRequest),{code:'ASSET_ALREADY_KNOWN'})
   const freshInvoice=await recipient.request('witnessReceive',[{assetId:aid,amount:'1000000',expirationSeconds:86400,minConfirmations:6}])
   const freshMint=await mint(recipient,runtime,freshInvoice,'1000000','fresh-imported-mint')
   await expectedBalance(recipient,aid,'1000000')
   await recipient.request('close');await recipient.open(data.fresh,'fresh-recipient');await expectedBalance(recipient,aid,'1000000')
   result.freshImport={address:freshAddress,funding:freshFunding,outputs:freshOutputs,assetId:aid,duplicateRejected:true,exportSha256:report.contract.sha256,mint:freshMint,restartBalance:'1000000'}
   // Actual BFA transfer between old-upgraded and fresh-imported wallets.
   const bfaInvoice=await recipient.request('blindReceive',[{assetId:aid,amount:'500000',minConfirmations:6}])
   const sent=await p.request('sendRgbInvoice',[{operationId:'upgrade-'+runtime+'-bfa-to-fresh-send',assetId:aid,invoice:bfaInvoice.invoice,amount:'500000',feeRate:'2',minConfirmations:6}])
   await settle(p,recipient,sent.txid);await expectedBalance(p,aid,'4500000');await expectedBalance(recipient,aid,'1500000')
   result.bfaTransfer={txid:sent.txid,sender:'4500000',recipient:'1500000'}
   result.ordinary=[]
   for(const schema of ['Nia','Cfa']){
    const issued=await p.request('issueAsset'+schema,[{operationId:'upgrade-'+runtime+'-issue-'+schema.toLowerCase()+'-asset',name:'Contract Upgrade '+schema,...(schema==='Nia'&&{ticker:'VTEST'}),precision:2,amounts:['1000']}])
    const bytes=Buffer.from((await p.request('export',[issued.assetId])).base64,'base64')
    await recipient.request('register',[],{assetId:issued.assetId,sha256:digest(bytes),contract:bytes.toString('base64')})
    const inv=await recipient.request('witnessReceive',[{assetId:issued.assetId,amount:'100',minConfirmations:6}])
    const tx=await p.request('sendRgbInvoice',[{operationId:'upgrade-'+runtime+'-send-'+schema.toLowerCase()+'-asset',assetId:issued.assetId,invoice:inv.invoice,amount:'100',feeRate:'2',minConfirmations:6,witnessAmountSats:'1000'}])
    await settle(p,recipient,tx.txid);await expectedBalance(p,issued.assetId,'900');await expectedBalance(recipient,issued.assetId,'100')
    result.ordinary.push({schema,assetId:issued.assetId,contractSha256:digest(bytes),txid:tx.txid,sender:'900',recipient:'100'})
   }
   // Bitcoin send after the BFA native database and RGB stock upgrades.
   const btcInvoice=await recipient.request('getNewAddress')
   const btcTx=await p.request('sendBtc',[{operationId:'upgrade-'+runtime+'-btc-after-restart',address:btcInvoice,amount:'10000',feeRate:'2'}]);await mine()
   assert.equal((await p.request('recoverSend',['upgrade-'+runtime+'-btc-after-restart'])).txid,btcTx.txid)
   result.btcTransfer={txid:btcTx.txid,amount:'10000'}
   await p.request('close');await recipient.request('close');await p.open(data);await recipient.open(data.fresh,'fresh-recipient')
   await expectedBalance(p,aid,'4500000');await expectedBalance(recipient,aid,'1500000')
   for(const row of result.ordinary){await expectedBalance(p,row.assetId,'900');await expectedBalance(recipient,row.assetId,'100')}
   assert.deepEqual(await p.request('recoverBurn',[lostBurn.operationId]),recovered)
   result.complete=true;data.upgraded=true;await save(privateFile,state);await save(evidence,report)
   console.log(runtime+' rc.3→'+version+' funded upgrade, import/export, lost burn reply, BTC/BFA/NIA/CFA transfers passed')
  }finally{await recipient?.stop();await p.stop()}
 }
}
