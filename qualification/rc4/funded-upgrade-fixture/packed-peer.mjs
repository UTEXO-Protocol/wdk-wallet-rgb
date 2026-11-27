import { WalletManagerRgb, burnDestinationFor } from '@utexo/wdk-wallet-rgb'
const isBare = typeof Bare !== 'undefined'
const io = isBare ? (await import('bare-stdio')).default : { in: process.stdin, out: process.stdout }
const codec = (await import('@scure/base')).base64
let manager, account, restoreHook, calls = [], reviews = []
async function dispatch (request) {
 const { method, args = [], params } = request
 if (method === 'open') {
  if (manager) throw new Error('Already open')
  manager = new WalletManagerRgb(Uint8Array.from(params.seed), { ...params.config,
   authorize: review => { reviews.push(review); return true }, authorizeMessage: () => true })
  try { account = await manager.getAccount() } catch (e) { await manager.shutdown();manager=undefined; throw e }
  return true
 }
 if (method === 'close' || method === 'stop') { restoreHook?.();restoreHook=undefined;await manager?.shutdown();manager=undefined;account=undefined;return true }
 if (method === 'instrument') {
  const filename = './src/onchain-' + (isBare ? 'bare-worker' : 'worker') + '.js'
  const RuntimeURL = isBare ? (await import('bare-url')).URL : URL
  const { OnchainWorker } = await import(new RuntimeURL(filename, import.meta.resolve('@utexo/wdk-wallet-rgb')))
  const original = OnchainWorker.prototype.request
  OnchainWorker.prototype.request = async function (operation, input) {
   calls.push(operation)
   const result = await original.call(this, operation, input)
   if (operation === params?.loseOperation) {
    restoreHook();restoreHook=undefined
    await this.close()
    throw Object.assign(new Error('Fixture dropped committed native response'), { code: 'NATIVE_CLOSED' })
   }
   return result
  }
  restoreHook=()=>{OnchainWorker.prototype.request=original}
  return true
 }
 if (method === 'instrumentation') return {calls,reviews}
 if (method === 'trustedReceive') return account.receiveWebRgbInvoice({...params,assertAuthorized(){},async approve(){reviews.push({kind:'invoice',operationId:params.operationId})}})
 if (method === 'burn') return account.burnAsset({...params,burnDestination:burnDestinationFor(params.burnRecipient,[{chainId:'eip155:42161',dstEid:0}])})
 if (method === 'register') return account.registerAssetContract({...params,contract:codec.decode(params.contract)})
 if (method === 'export') return {base64:codec.encode(await account.exportAssetContract(args[0]))}
 return account[method](...args)
}
let buffer=''
try {
 outer:for await(const chunk of io.in){buffer+=chunk.toString();let at
  while((at=buffer.indexOf('\n'))!==-1){const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);let reply
   try{reply={id:request.id,result:(await dispatch(request))??null}}catch(error){reply={id:request.id,error:{code:error.code??error.name,message:error.message}}}
   await new Promise((yes,no)=>io.out.write(JSON.stringify(reply,(_,v)=>typeof v==='bigint'?v.toString():v)+'\n',e=>e?no(e):yes()))
   if(request.method==='stop')break outer
  }
 }
}finally{restoreHook?.();await manager?.shutdown()}
if(isBare)Bare.exit(0)
