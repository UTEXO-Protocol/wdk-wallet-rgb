use std::{collections::HashMap, fs::{self, OpenOptions}, io::{self, Read, Write}, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::{Path, PathBuf}, str::FromStr};
use rgb_lib::{AssetSchema, Assignment, BitcoinNetwork, FileContent, LockId, RgbTransfer, RgbTxid, bitcoin::psbt::Psbt};
use rgb_lib::keys::{Keys, generate_keys, WitnessVersion};
use rgb_lib::wallet::{AssetFilter, DatabaseType, EvmChain, IndexerConfig, Invoice, OnlineOptions, Recipient, RecipientInfo, RecipientType, RgbWalletOpsOffline, RgbWalletOpsOnline, SinglesigKeys, TransferScope, Wallet, WalletData, WitnessData};
use rgbstd::OpId;
use serde_json::{Value, json};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn persist(path: &Path, data: &Value) -> Result<()> {
 let temporary=path.with_extension("tmp");
 let mut f=OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temporary)?;
 f.write_all(&serde_json::to_vec_pretty(data)?)?; f.sync_all()?; fs::rename(&temporary,path)?;
 fs::File::open(path.parent().unwrap())?.sync_all()?; Ok(())
}
fn string(v:&Value,k:&str)->Result<String>{Ok(v.get(k).and_then(Value::as_str).ok_or_else(||format!("missing {k}"))?.to_string())}
fn number(v:&Value,k:&str)->Result<u64>{Ok(v.get(k).and_then(Value::as_u64).ok_or_else(||format!("missing {k}"))?)}
fn run()->Result<Value>{
 let args:Vec<String>=std::env::args().collect(); let root=PathBuf::from(args.get(1).ok_or("issuer root required")?);
 fs::create_dir_all(&root)?; fs::set_permissions(&root,fs::Permissions::from_mode(0o700))?;
 let mut input=String::new();io::stdin().read_to_string(&mut input)?;let req:Value=serde_json::from_str(&input)?;let cmd=string(&req,"command")?;
 let kp=root.join("keys.private.json");
 let keys:Keys=if kp.exists(){serde_json::from_slice(&fs::read(&kp)?)?}else{if cmd!="init"{return Err("issuer not initialized".into())}let k=generate_keys(BitcoinNetwork::Regtest,WitnessVersion::Taproot);persist(&kp,&serde_json::to_value(&k)?)?;k};
 let wd=root.join("wallet");fs::create_dir_all(&wd)?;
 let mut wallet=Wallet::new(WalletData{data_dir:wd.to_string_lossy().into_owned(),bitcoin_network:BitcoinNetwork::Regtest,database_type:DatabaseType::Sqlite,max_allocations_per_utxo:1,supported_schemas:vec![AssetSchema::Bfa,AssetSchema::Nia,AssetSchema::Cfa,AssetSchema::Ifa,AssetSchema::Uda],allow_reckless_schemas:false},SinglesigKeys::from_keys(&keys,Some(0)))?;
 if cmd=="init"||cmd=="address" {return Ok(json!({"address":wallet.get_address()?,"walletDir":wallet.get_wallet_dir()}))}
 if cmd=="assets"{return Ok(serde_json::to_value(wallet.list_assets(vec![])?)?)}
 if cmd=="balance"{return Ok(serde_json::to_value(wallet.get_asset_balance(string(&req,"assetId")?)?)?)}
 if cmd=="transfers"{return Ok(serde_json::to_value(wallet.list_transfers(AssetFilter::AnyOrNone,TransferScope::All)?)?)}
 let online=wallet.go_online(OnlineOptions{indexer_config:IndexerConfig::Electrum{url:"tcp://127.0.0.1:48001".into()},skip_consistency_check:false,vanilla_sync_lookback:20,failed_witness_receive_grace_secs:86400,proxy_auth_keys:HashMap::new(),evm_chains:HashMap::from([(31337,EvmChain{rpc_url:"http://127.0.0.1:48545".into(),min_mint_lock_blocks:2,max_mint_lock_blocks:1_000_000})])})?;
 match cmd.as_str(){
 "outputs"=>Ok(json!({"created":wallet.create_utxos(online,false,Some(20),Some(20000),2,false)?})),
 "refresh"=>Ok(serde_json::to_value(wallet.refresh(online,None,vec![],false)?)?),
 "issue"=>{let p=root.join("asset.json");if p.exists(){return Ok(serde_json::from_slice(&fs::read(p)?)?)}
 let a=wallet.issue_asset_bfa("BUSDT".into(),"Upgrade Fixture Dollar".into(),6,10,31337,string(&req,"bridge")?,None,false,None,false)?;let v=serde_json::to_value(a)?;persist(&p,&v)?;Ok(v)},
 "mint-begin"=>{
 let op=string(&req,"operationId")?;if op.is_empty()||!op.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){return Err("invalid operationId".into())}
 let p=root.join(format!("mint-{op}.json"));if p.exists(){let saved:Value=serde_json::from_slice(&fs::read(p)?)?;if saved["request"]!=req{return Err("operationId conflict".into())}return Ok(saved["public"].clone())}
 let asset_id=string(&req,"assetId")?;let amount=number(&req,"amount")?;let invoice=Invoice::new(string(&req,"invoice")?)?.invoice_data();
 if invoice.network!=BitcoinNetwork::Regtest||invoice.asset_id.as_ref().is_some_and(|a|a!=&asset_id){return Err("invoice asset/network mismatch".into())}
 if let Assignment::Fungible(n)=invoice.assignment {if n!=0&&n!=amount{return Err("invoice amount mismatch".into())}}
 if invoice.expiration_timestamp.is_some_and(|expiry|expiry<=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()){return Err("invoice expired".into())}
 let witness=matches!(RecipientInfo::new(invoice.recipient_id.clone())?.recipient_type,RecipientType::Witness);
 let recipient=Recipient{recipient_id:invoice.recipient_id,witness_data:if witness{Some(WitnessData{amount_sat:10000,blinding:None})}else{None},assignment:Assignment::Fungible(amount),transport_endpoints:invoice.transport_endpoints,public_key:invoice.public_key,encryption:invoice.encryption,expiration_timestamp:None};
 // Persist an intent before the mutating API; an interrupted invocation must be inspected, never replayed.
 persist(&p,&json!({"request":req,"state":"invoking","public":{"operationId":op,"state":"uncertain"}}))?;
 let begun=wallet.mint_begin(online,asset_id,recipient,number(&req,"beforeBlock")?,2,1,"rpc://127.0.0.1:48090/json-rpc".into())?;
 let txid=Psbt::from_str(&begun.psbt)?.unsigned_tx.compute_txid().to_string();let lock=LockId::with(OpId::from_str(&begun.details.opid)?,RgbTxid::from_str(&txid)?).to_string();
 let signed=wallet.sign_psbt(begun.psbt.clone(),None)?;
 // Store signed PSBT and operation identity durably before the caller can make an EVM payment.
 let public=json!({"operationId":op,"state":"prepared","txid":txid,"lockId":lock,"opid":begun.details.opid,"batchTransferIdx":begun.batch_transfer_idx});
 persist(&p,&json!({"request":req,"state":"prepared","public":public,"signedPsbt":signed,"begin":begun}))?;
 Ok(public)},
 "mint-end"=>{let op=string(&req,"operationId")?;if !op.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){return Err("invalid operationId".into())}let p=root.join(format!("mint-{op}.json"));let mut saved:Value=serde_json::from_slice(&fs::read(&p)?)?;
 if saved["state"]=="submitted"{return Ok(saved["result"].clone())}if saved["state"]!="prepared"{return Err("uncertain mint requires reconciliation, refusing replay".into())}
 saved["state"]=json!("submitting");persist(&p,&saved)?;
 let res=wallet.mint_end(online,string(&saved,"signedPsbt")?)?;saved["state"]=json!("submitted");saved["result"]=serde_json::to_value(res)?;persist(&p,&saved)?;Ok(saved["result"].clone())},
 "export-contract-from-transfer"=>{let transfer=RgbTransfer::load_file(string(&req,"transferPath")?)?;let path=PathBuf::from(string(&req,"outputPath")?);transfer.into_contract().save_file(&path)?;Ok(json!({"path":path}))},
 _=>Err("unknown command".into())
 }
}
fn main(){match run(){Ok(v)=>println!("{}",v),Err(e)=>{eprintln!("issuer error: {e}");std::process::exit(1)}}}
