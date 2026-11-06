// SPDX-License-Identifier: Apache-2.0
//! Shared watch-only engine for the Node host and Bare addon.
use base64::{Engine, engine::general_purpose::STANDARD};
use fs2::FileExt;
use rgb_lib::bitcoin::{Address as BitcoinAddress, Network as Bitcoin, Psbt, Txid};
use rgb_lib::keys::WitnessVersion;
use rgb_lib::no_wallet::{BundleFilter, inspect_consignment};
use rgb_lib::wallet::{
    AssetFilter, Balance, DatabaseType, EvmChain, Invoice, Online, OnlineOptions, RecipientInfo,
    RgbInspection, RgbWalletOpsOffline, RgbWalletOpsOnline, SinglesigKeys, TransferScope,
    TransitionGlobal, Wallet, WalletData,
};
use rgb_lib::{AssetSchema, Assignment, BitcoinNetwork, TransferStatus, TypeOfTransition};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroize;

#[path = "read_api.rs"]
mod read_api;

#[path = "network.rs"]
mod network;

#[path = "recovery.rs"]
mod recovery;

#[path = "journal.rs"]
mod journal;

#[path = "send.rs"]
mod send;

const SOURCE: &str = "5010eefa355beb9c42a4c1b69883f7651241a111";
const OVERLAY: &str = "2b9bf63482d8a472492d065d3edd260e0fa418ac";
pub(crate) const MAX_FRAME: usize = 6 * 1024 * 1024;
const MAX_PSBT: usize = 2 * 1024 * 1024;
const MAX_CONTRACT: usize = 1024 * 1024;
const MAX_PROOF: usize = 10 * 1024 * 1024;
const MAX_FEE_RATE: u64 = 100_000;
const MAX_MONEY: u64 = 2_100_000_000_000_000;
const LOCK_FILE: &str = ".utexo-rgb-native.lock";
const IDENTITY_FILE: &str = ".utexo-rgb-native.identity";
const BACKEND: &str = "rgb-l1-bfa6-v1";
const REGTEST_MAX_MINT_LOCK_BLOCKS: u64 = 512;
const SIGNET_MAX_MINT_LOCK_BLOCKS: u64 = 7_200;

pub(crate) type Result<T> = std::result::Result<T, Fault>;

#[derive(Debug, Serialize)]
pub(crate) struct Fault {
    code: &'static str,
    message: &'static str,
}
fn fault(code: &'static str, message: &'static str) -> Fault {
    Fault { code, message }
}
pub(crate) fn input(message: &'static str) -> Fault {
    fault("INVALID_PARAMS", message)
}
fn native(err: rgb_lib::Error) -> Fault {
    match err {
        rgb_lib::Error::ContractIdMismatch { .. } => fault(
            "CONTRACT_MISMATCH",
            "The validated RGB contract has a different asset ID.",
        ),
        rgb_lib::Error::InvalidIndexer { .. } => fault(
            "INVALID_INDEXER",
            "The indexer is unavailable, incompatible, or on a different Bitcoin network.",
        ),
        rgb_lib::Error::CannotEstimateFees => fault(
            "FEE_UNAVAILABLE",
            "Indexer did not return a usable fee estimate.",
        ),
        rgb_lib::Error::AssetNotFound { .. } => fault(
            "ASSET_NOT_FOUND",
            "The asset is not registered in this wallet.",
        ),
        _ => fault(
            "NATIVE_OPERATION_FAILED",
            "The RGB wallet could not complete the operation.",
        ),
    }
}
fn storage(_: io::Error) -> Fault {
    fault(
        "STORAGE_ERROR",
        "Unable to open or persist private wallet storage.",
    )
}
fn proof_error() -> Fault {
    fault(
        "PROOF_UNAVAILABLE",
        "No matching committed BFA burn proof is available.",
    )
}

fn decode<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|_| input("Malformed operation parameters."))
}
fn exact(s: &str, max: u64) -> Result<u64> {
    if s.is_empty()
        || s.len() > 20
        || (s.len() != 1 && s.starts_with('0'))
        || !s.bytes().all(|x| x.is_ascii_digit())
    {
        return Err(input("Expected a canonical unsigned decimal string."));
    }
    s.parse::<u64>()
        .ok()
        .filter(|value| *value <= max)
        .ok_or_else(|| input("Unsigned value is outside its allowed range."))
}
fn positive(s: &str, max: u64) -> Result<u64> {
    match exact(s, max)? {
        0 => Err(input("Expected a positive value.")),
        n => Ok(n),
    }
}
fn lower_hex(s: &str, length: usize) -> bool {
    s.len() == length
        && s.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
fn require_txid(s: &str) -> Result<()> {
    if !lower_hex(s, 64) || Txid::from_str(s).is_err() {
        return Err(input("Expected a canonical transaction ID."));
    }
    Ok(())
}
fn require_asset(s: &str) -> Result<()> {
    if s.len() > 256 || rgb_lib::ContractId::from_str(s).is_err() || !s.starts_with("rgb:") {
        return Err(input("Expected an RGB contract ID."));
    }
    Ok(())
}
fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    data_dir: String,
    network: String,
    account_xpub_vanilla: String,
    account_xpub_colored: String,
    master_fingerprint: String,
    #[serde(default)]
    mode: journal::Mode,
    profile: Option<crate::profile::Profile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Credentials {
    pub(crate) username: String,
    pub(crate) password: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoOnline {
    indexer_url: String,
    bitcoind_auth: Option<Credentials>,
    #[serde(default)]
    evm_rpc_urls: BTreeMap<String, String>,
    #[serde(default)]
    proxy_auth_keys: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receive {
    asset_id: Option<String>,
    amount: Option<String>,
    transport_endpoints: Vec<String>,
    expiration_timestamp: String,
    min_confirmations: u8,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateOutputs {
    count: u8,
    size: String,
    fee_rate: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Burn {
    asset_id: String,
    amount: String,
    fee_rate: String,
    min_confirmations: u8,
    commitment: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Signed {
    signed_psbt: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    asset_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Filter {
    asset_id: Option<String>,
    txid: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Refresh {
    asset_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    asset_id: String,
    txid: String,
    commitment: String,
    amount: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contract {
    contract_base64: String,
    expected_asset_id: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipientId {
    recipient_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionId {
    txid: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeeEstimate {
    blocks: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InvoiceInput {
    invoice: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
enum Kind {
    #[serde(rename = "rgb-output")]
    Outputs,
    #[serde(rename = "btc-send")]
    Btc,
    #[serde(rename = "rgb-send")]
    Rgb,
    #[serde(rename = "rgb-burn")]
    Burn,
}
struct Prepared {
    kind: Kind,
    psbt: Psbt,
    txid: String,
    batch_idx: Option<i32>,
    discard_requested: bool,
}
struct Session {
    // Drop the wallet and its local database before releasing ownership of its directory.
    wallet: Wallet,
    _directory_lock: File,
    root: PathBuf,
    journal_identity: String,
    journal_mode: journal::Mode,
    network: BitcoinNetwork,
    profile: Option<crate::profile::Profile>,
    online: Option<Online>,
    indexer_url: Option<String>,
    prepared: Option<Prepared>,
}
#[derive(Default)]
pub(crate) struct Worker {
    session: Option<Session>,
}

fn chain(network: &str) -> Result<BitcoinNetwork> {
    match network {
        "signet" => Ok(BitcoinNetwork::Signet),
        "regtest" => Ok(BitcoinNetwork::Regtest),
        _ => Err(input("Unsupported Bitcoin network.")),
    }
}

fn public_signet_btc_only() -> Fault {
    fault("RGB_MODE_UNAVAILABLE", "This Signet wallet is configured for Bitcoin only.")
}
fn bitcoin_chain(network: BitcoinNetwork) -> Bitcoin {
    match network {
        BitcoinNetwork::Mainnet => Bitcoin::Bitcoin,
        BitcoinNetwork::Testnet => Bitcoin::Testnet,
        BitcoinNetwork::Testnet4 => Bitcoin::Testnet4,
        BitcoinNetwork::Signet => Bitcoin::Signet,
        BitcoinNetwork::Regtest => Bitcoin::Regtest,
        BitcoinNetwork::SignetCustom => unreachable!("custom Signet is not admitted"),
    }
}

fn read_bounded(path: &Path, max: usize) -> io::Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid file size or type",
        ));
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() != metadata.len() as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed during read",
        ));
    }
    Ok(bytes)
}

fn open_root(path: &str) -> Result<(PathBuf, File)> {
    let path = Path::new(path);
    if !path.is_absolute() || path.as_os_str().len() > 4096 {
        return Err(input(
            "Expected an absolute path to dedicated private wallet storage.",
        ));
    }
    let meta = path.symlink_metadata().map_err(storage)?;
    if !meta.is_dir()
        || meta.permissions().mode() & 0o777 != 0o700
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return Err(input(
            "The wallet directory must be owned by the caller, private, and not a symlink.",
        ));
    }
    let canonical = path.canonicalize().map_err(storage)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(canonical.join(LOCK_FILE))
        .map_err(storage)?;
    let lock_meta = file.metadata().map_err(storage)?;
    if !lock_meta.is_file()
        || lock_meta.uid() != meta.uid()
        || lock_meta.nlink() != 1
        || lock_meta.permissions().mode() & 0o777 != 0o600
    {
        return Err(fault("STORAGE_ERROR", "Unsafe wallet ownership lock."));
    }
    FileExt::try_lock_exclusive(&file).map_err(|_| {
        fault(
            "WALLET_IN_USE",
            "Another wallet worker already owns this directory.",
        )
    })?;
    Ok((canonical, file))
}

fn bind_identity(root: &Path, params: &Open, network: BitcoinNetwork) -> Result<()> {
    let path = root.join(IDENTITY_FILE);
    let mut identity = json!({
        "backend": BACKEND,
        "network": format!("{network:?}"),
        "accountXpubVanilla": params.account_xpub_vanilla,
        "accountXpubColored": params.account_xpub_colored,
        "masterFingerprint": params.master_fingerprint,
    });
    if let Some(profile) = params.profile {
        identity["profile"] = json!(profile);
    }
    let expected = serde_json::to_vec(&identity)
        .map_err(|_| fault("INTERNAL", "Could not encode wallet identity."))?;
    match read_bounded(&path, 4096) {
        Ok(existing) if existing == expected => Ok(()),
        Ok(_) => Err(fault(
            "WALLET_IDENTITY_MISMATCH",
            "This directory belongs to a different RGB wallet.",
        )),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let dir = root.join(&params.master_fingerprint);
            if dir.symlink_metadata().is_ok() {
                return Err(fault(
                    "UNADMITTED_WALLET_STATE",
                    "Legacy wallet state requires explicit migration.",
                ));
            }
            let mut staged = tempfile::NamedTempFile::new_in(root).map_err(storage)?;
            staged.write_all(&expected).map_err(storage)?;
            staged.as_file().sync_all().map_err(storage)?;
            staged
                .persist_noclobber(path)
                .map_err(|e| storage(e.error))?;
            File::open(root).and_then(|f| f.sync_all()).map_err(storage)
        }
        Err(err) => Err(storage(err)),
    }
}

pub(crate) fn validated_url(value: &str, allowed: &[&str], allow_plain: bool) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| input("Invalid network endpoint."))?;
    if value.len() > 2048
        || value.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace() || b == b'\\')
        || value.split_once("://").is_none_or(|(_, tail)| {
            tail.split('/').next().is_none_or(|host| host.is_empty() || host.contains('@'))
        })
        || !allowed.contains(&url.scheme())
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port() == Some(0)
        || url.fragment().is_some()
        || url.query().is_some()
        || (!allow_plain && matches!(url.scheme(), "http" | "tcp" | "rpc"))
        || (allow_plain && !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    {
        return Err(input(
            "Network endpoint is not admitted by this wallet profile.",
        ));
    }
    Ok(url)
}
fn validate_proxy(endpoint: &str, regtest: bool) -> Result<()> {
    validated_url(endpoint, &["rpc", "rpcs"], regtest).map(|_| ())
}
fn iso_balance(b: Balance) -> Value {
    json!({
        "settled": b.settled.to_string(),
        "future": b.future.to_string(),
        "spendable": b.spendable.to_string(),
    })
}
fn optional_amount(a: Option<String>) -> Result<Assignment> {
    a.map(|s| positive(&s, u64::MAX).map(Assignment::Fungible))
        .transpose()
        .map(|a| a.unwrap_or(Assignment::Any))
}
fn assignment_value(a: &Assignment) -> Value {
    match a {
        Assignment::Fungible(n) => json!({"fungible": n.to_string()}),
        Assignment::InflationRight(n) => json!({"inflationRight": n.to_string()}),
        Assignment::NonFungible => json!({"nonFungible": true}),
        Assignment::MintRight => json!({"mintRight": true}),
        Assignment::LinkRight => json!({"linkRight": true}),
        Assignment::Any => json!({"any": true}),
    }
}
fn tx_id(psbt: &Psbt) -> String {
    psbt.unsigned_tx.compute_txid().to_string()
}
fn parse_psbt(data: &str) -> Result<Psbt> {
    if data.is_empty() || data.len() > MAX_PSBT {
        return Err(input("Invalid PSBT length."));
    }
    Psbt::from_str(data).map_err(|_| input("Invalid PSBT."))
}
fn has_witnesses(signed: &Psbt) -> bool {
    !signed.inputs.is_empty()
        && signed.inputs.iter().all(|i| {
            i.final_script_sig.is_none()
                && i.final_script_witness
                    .as_ref()
                    .is_some_and(|w| w.len() == 1 && w.iter().next().is_some_and(|s| s.len() == 64))
        })
}
fn assert_signed_plan(pending: &Prepared, signed: &Psbt) -> Result<()> {
    let mut unsigned = signed.clone();
    for i in &mut unsigned.inputs {
        i.final_script_witness = None;
    }
    if !has_witnesses(signed) || unsigned != pending.psbt {
        return Err(fault(
            "SIGNED_PLAN_MISMATCH",
            "The signed PSBT does not match the exact prepared wallet transaction.",
        ));
    }
    Ok(())
}

fn burn_matches(
    inspection: &RgbInspection,
    asset: &str,
    txid: &str,
    commitment: &str,
    amount: Option<u64>,
) -> Option<u64> {
    if inspection.txid != txid {
        return None;
    }
    let mut matches = inspection
        .operations
        .iter()
        .filter(|o| o.asset_id == asset)
        .flat_map(|o| o.transitions.iter())
        .filter(|t| t.r#type == TypeOfTransition::Burn);
    let transition = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let reasons: Vec<&str> = transition
        .globals
        .iter()
        .filter_map(|g| match g {
            TransitionGlobal::BurnReason(reason) => Some(reason.as_str()),
            _ => None,
        })
        .collect();
    let burned: Vec<u64> = transition
        .globals
        .iter()
        .filter_map(|g| match g {
            TransitionGlobal::BurnedAsset(n) => Some(*n),
            _ => None,
        })
        .collect();
    match (reasons.as_slice(), burned.as_slice()) {
        ([r], [n]) if *r == commitment && *n > 0 && amount.is_none_or(|a| a == *n) => Some(*n),
        _ => None,
    }
}

impl Worker {
    fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        match method {
            "version" => {
                let _: Empty = decode(params)?;
                Ok(crate::profile::version(SOURCE, OVERLAY))
            }
            "open" => {
                if self.session.is_some() {
                    return Err(fault(
                        "WALLET_ALREADY_OPEN",
                        "The worker already owns a wallet.",
                    ));
                }
                let p: Open = decode(params)?;
                let network = chain(&p.network)?;
                let signet_rgb = network == BitcoinNetwork::Signet && p.mode == journal::Mode::Rgb;
                if signet_rgb && p.profile.is_none() {
                    return Err(fault(
                        "RGB_MODE_UNAVAILABLE",
                        "Signet RGB requires an explicit profile.",
                    ));
                }
                if let Some(profile) = p.profile {
                    if !signet_rgb {
                        return Err(input("The selected profile requires a Signet RGB wallet."));
                    }
                    profile.services()?;
                }
                if !lower_hex(&p.master_fingerprint, 8)
                    || !(100..=120).contains(&p.account_xpub_vanilla.len())
                    || !(100..=120).contains(&p.account_xpub_colored.len())
                    || p.account_xpub_colored == p.account_xpub_vanilla
                    || rgb_lib::bitcoin::bip32::Xpub::from_str(&p.account_xpub_vanilla).is_err()
                    || rgb_lib::bitcoin::bip32::Xpub::from_str(&p.account_xpub_colored).is_err()
                {
                    return Err(input(
                        "Invalid distinct public account keys or fingerprint.",
                    ));
                }
                let (root, lock) = open_root(&p.data_dir)?;
                bind_identity(&root, &p, network)?;
                let mut identity_fields = vec![
                    p.network.as_str(),
                    p.account_xpub_vanilla.as_str(),
                    p.account_xpub_colored.as_str(),
                    p.master_fingerprint.as_str(),
                ];
                if let Some(profile) = p.profile {
                    identity_fields.push(profile.as_str());
                } else if p.mode == journal::Mode::BtcOnly {
                    identity_fields.push(p.mode.as_str());
                }
                let journal_identity = sha256(&serde_json::to_vec(&identity_fields)
                    .map_err(|_| input("Invalid wallet journal identity."))?);
                let fingerprint_path = root.join(&p.master_fingerprint);
                if let Ok(meta) = fingerprint_path.symlink_metadata() {
                    if !meta.is_dir() {
                        return Err(fault("STORAGE_ERROR", "Invalid wallet data directory."));
                    }
                }
                let data_dir = root
                    .to_str()
                    .ok_or_else(|| input("Invalid wallet directory encoding."))?
                    .to_owned();
                let wallet = Wallet::new(
                    WalletData {
                        data_dir,
                        bitcoin_network: network,
                        database_type: DatabaseType::Sqlite,
                        max_allocations_per_utxo: 1,
                        supported_schemas: vec![
                            AssetSchema::Bfa,
                            AssetSchema::Nia,
                            AssetSchema::Cfa,
                            AssetSchema::Uda,
                            AssetSchema::Ifa,
                        ],
                    },
                    SinglesigKeys {
                        account_xpub_vanilla: p.account_xpub_vanilla,
                        account_xpub_colored: p.account_xpub_colored,
                        vanilla_keychain: Some(0),
                        master_fingerprint: p.master_fingerprint,
                        mnemonic: None,
                        witness_version: WitnessVersion::Taproot,
                    },
                );
                crate::profile::after_wallet_new();
                let wallet = wallet.map_err(native)?;
                self.session = Some(Session {
                    wallet,
                    _directory_lock: lock,
                    root,
                    journal_identity,
                    journal_mode: p.mode,
                    network,
                    profile: p.profile,
                    online: None,
                    indexer_url: None,
                    prepared: None,
                });
                let mut opened = json!({"network":p.network,"watchOnly":true});
                if let Some(profile) = p.profile {
                    opened["profile"] = json!(profile);
                }
                Ok(opened)
            }
            "close" => {
                let _: Empty = decode(params)?;
                drop(self.session.take());
                Ok(json!({}))
            }
            _ => self
                .session
                .as_mut()
                .ok_or_else(|| fault("WALLET_CLOSED", "No wallet is open."))?
                .dispatch(method, params),
        }
    }
}

impl Session {
    fn validate_wallet_proxy(&self, endpoint: &str) -> Result<()> {
        if self.network == BitcoinNetwork::Signet {
            let services = self
                .profile
                .ok_or_else(|| input("RGB proxy requires a Signet RGB profile."))?
                .services()?;
            if endpoint != services.proxy {
                return Err(input("The wallet requires the approved RGB proxy for its Signet profile."));
            }
        }
        validate_proxy(endpoint, self.network == BitcoinNetwork::Regtest)
    }

    fn online(&self) -> Result<Online> {
        self.online.ok_or_else(|| {
            fault(
                "WALLET_OFFLINE",
                "The RGB wallet has no online indexer session.",
            )
        })
    }
    fn skip_read_sync(&self) -> bool {
        self.online.is_none() || self.prepared.is_some()
    }
    fn idle(&self) -> Result<()> {
        if self.prepared.is_some() {
            return Err(fault(
                "OPERATION_PREPARED",
                "A prepared transaction is still owned by this worker.",
            ));
        }
        Ok(())
    }
    fn prepare(&mut self, kind: Kind, raw_psbt: String, batch_idx: Option<i32>) -> Result<Value> {
        let psbt = parse_psbt(&raw_psbt)?;
        if psbt.inputs.is_empty()
            || psbt.inputs.iter().any(|i| {
                i.final_script_sig.is_some()
                    || i.final_script_witness.is_some()
                    || i.witness_utxo.is_none()
            })
        {
            return Err(fault(
                "INVALID_PREPARED_PLAN",
                "The native wallet did not produce an unsigned witness PSBT.",
            ));
        }
        let txid = tx_id(&psbt);
        let mut reply = json!({"psbt":raw_psbt,"txid":txid});
        if let Some(idx) = batch_idx {
            reply["batchTransferIdx"] = idx.into();
        }
        self.prepared = Some(Prepared {
            kind,
            psbt,
            txid,
            batch_idx,
            discard_requested: false,
        });
        Ok(reply)
    }
    fn submit(&mut self, kind: Kind, p: Signed) -> Result<Value> {
        let online = self.online()?;
        let signed = parse_psbt(&p.signed_psbt)?;
        let pending = self
            .prepared
            .as_ref()
            .filter(|p| p.kind == kind && !p.discard_requested)
            .ok_or_else(|| {
                fault(
                    "NO_PREPARED_OPERATION",
                    "This worker does not own the specified operation.",
                )
            })?;
        assert_signed_plan(pending, &signed)?;
        // Consume the authority before the possibly irreversible native call. Do not restore
        // it even on failure: the server may have accepted/broadcast the transaction.
        let pending = self.prepared.take().expect("checked above");
        let (actual, batch, created) = match kind {
            Kind::Outputs => {
                let count = self
                    .wallet
                    .create_utxos_end(online, p.signed_psbt)
                    .map_err(native)?;
                (pending.txid.clone(), None, Some(count))
            }
            Kind::Btc => {
                let txid = self
                    .wallet
                    .send_btc_end(online, p.signed_psbt)
                    .map_err(native)?;
                (txid, None, None)
            }
            Kind::Rgb => {
                let out = self
                    .wallet
                    .send_end(online, p.signed_psbt)
                    .map_err(native)?;
                (out.txid, Some(out.batch_transfer_idx), None)
            }
            Kind::Burn => {
                let out = self
                    .wallet
                    .burn_end(online, p.signed_psbt)
                    .map_err(native)?;
                (out.txid, Some(out.batch_transfer_idx), None)
            }
        };
        if actual != pending.txid || pending.batch_idx.is_some_and(|idx| batch != Some(idx)) {
            return Err(fault(
                "UNEXPECTED_OPERATION_RESULT",
                "Native result did not match the submitted transaction. Reconcile before any retry.",
            ));
        }
        let mut reply = json!({"txid":actual});
        if let Some(idx) = batch {
            reply["batchTransferIdx"] = idx.into();
        }
        if let Some(count) = created {
            reply["created"] = count.into();
        }
        Ok(reply)
    }
    fn discard_prepared(&mut self, p: TransactionId) -> Result<Value> {
        require_txid(&p.txid)?;
        let pending = self
            .prepared
            .as_mut()
            .filter(|pending| pending.txid == p.txid)
            .ok_or_else(|| {
                fault(
                    "NO_PREPARED_OPERATION",
                    "This worker does not own the specified operation.",
                )
            })?;
        // The guard was consumed before entering every End. Only an unsigned operation that
        // this exact live worker prepared can be discarded. Never inspect-and-abort after reopen.
        pending.discard_requested = true;
        match pending.kind {
            Kind::Outputs | Kind::Btc => self
                .wallet
                .abort_pending_vanilla_tx(p.txid)
                .map_err(native)?,
            Kind::Burn | Kind::Rgb => {
                let expected = if pending.kind == Kind::Burn {
                    rgb_lib::wallet::TransferKind::Burn
                } else {
                    rgb_lib::wallet::TransferKind::Send
                };
                let batch = pending.batch_idx.ok_or_else(|| {
                    fault(
                        "DISCARD_UNCERTAIN",
                        "No exact prepared RGB batch was recorded.",
                    )
                })?;
                let rows = self
                    .wallet
                    .list_transfers(AssetFilter::AnyOrNone, TransferScope::Txid(p.txid.clone()))
                    .map_err(native)?;
                let matching = rows
                    .iter()
                    .filter(|row| {
                        row.kind == expected
                            && row.batch_transfer_idx == batch
                            && row.status == TransferStatus::Initiated
                            && row.txid.as_deref() == Some(&p.txid)
                    })
                    .count();
                if matching != 1
                    || !self
                        .wallet
                        .fail_transfers(self.online()?, Some(batch), false, false)
                        .map_err(native)?
                {
                    return Err(fault(
                        "DISCARD_UNCERTAIN",
                        "The exact unsigned RGB transaction could not be released safely.",
                    ));
                }
            }
        }
        // On error keep the declined plan as a block, with no remaining submission authority.
        self.prepared = None;
        Ok(json!({}))
    }
    fn go_online(&mut self, mut p: GoOnline) -> Result<Value> {
        self.idle()?;
        let regtest = self.network == BitcoinNetwork::Regtest;
        let config = crate::profile::indexer(
            p.indexer_url,
            p.bitcoind_auth.take(),
            self.network,
            self.profile,
        )?;
        let indexer_url = config.url().to_owned();
        if self.journal_mode == journal::Mode::BtcOnly
            && (!p.evm_rpc_urls.is_empty() || !p.proxy_auth_keys.is_empty())
        {
            for secret in p.proxy_auth_keys.values_mut() {
                secret.zeroize();
            }
            return Err(input("Bitcoin-only mode does not accept RGB service configuration."));
        }
        if let Some(profile) = self.profile {
            let services = profile.services()?;
            if p.evm_rpc_urls.len() != 1
                || p.evm_rpc_urls.get("42161").map(String::as_str) != Some(services.arbitrum_rpc)
                || !p.proxy_auth_keys.is_empty()
            {
                for secret in p.proxy_auth_keys.values_mut() {
                    secret.zeroize();
                }
                return Err(input("Signet RGB requires the approved Arbitrum RPC without proxy credentials."));
            }
        }
        if p.evm_rpc_urls.len() > 16 || p.proxy_auth_keys.len() > 16 {
            return Err(input("Too many network endpoints."));
        }
        let mut evm_chains = HashMap::new();
        for (id, url) in p.evm_rpc_urls {
            validated_url(&url, &["https", "http"], regtest)?;
            // Bound how long a pending mint can keep its receiving UTXO reserved.
            // The isolated issuer commits at most 512 Anvil blocks ahead. Signet
            // admits a fixed Arbitrum-only budget through its pinned RPC policy.
            evm_chains.insert(
                positive(&id, u64::MAX)?,
                EvmChain {
                    rpc_url: url,
                    min_mint_lock_blocks: 2,
                    max_mint_lock_blocks: if regtest {
                        REGTEST_MAX_MINT_LOCK_BLOCKS
                    } else {
                        SIGNET_MAX_MINT_LOCK_BLOCKS
                    },
                },
            );
        }
        for (url, secret) in &p.proxy_auth_keys {
            validate_proxy(url, regtest)?;
            if !lower_hex(secret, 64) {
                return Err(input("Invalid proxy authentication key."));
            }
        }
        let mut options = OnlineOptions {
            indexer_config: config,
            skip_consistency_check: false,
            vanilla_sync_lookback: 20,
            failed_witness_receive_grace_secs: 86_400,
            proxy_auth_keys: p.proxy_auth_keys.into_iter().collect(),
            evm_chains,
        };
        let online = self.wallet.go_online(options.clone());
        // The caller-provided copy is no longer needed. Upstream owns the runtime copy of
        // required credentials until wallet drop; no credentials are serialized in responses.
        for secret in options.proxy_auth_keys.values_mut() {
            secret.zeroize();
        }
        crate::profile::clear_indexer_credentials(&mut options.indexer_config);
        self.online = None;
        self.indexer_url = None;
        self.online = Some(online.map_err(native)?);
        self.indexer_url = Some(indexer_url);
        Ok(json!({}))
    }
    fn receive(&mut self, p: Receive, blind: bool) -> Result<Value> {
        self.idle()?;
        let online = self.online()?;
        if let Some(asset) = &p.asset_id {
            require_asset(asset)?;
        }
        if p.transport_endpoints.is_empty()
            || p.transport_endpoints.len() > 3
            || (self.network == BitcoinNetwork::Signet && p.transport_endpoints.len() != 1)
            || p.min_confirmations == 0
        {
            return Err(input(
                "A proxy endpoint and positive confirmation policy are required.",
            ));
        }
        for endpoint in &p.transport_endpoints {
            self.validate_wallet_proxy(endpoint)?;
        }
        let expiry = positive(&p.expiration_timestamp, i64::MAX as u64)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| fault("INVALID_CLOCK", "The device clock is unavailable."))?
            .as_secs();
        if expiry < now.saturating_add(900) || expiry > now.saturating_add(7 * 86_400) {
            return Err(input(
                "Invoice expiry must be 15 minutes to 7 days from now.",
            ));
        }
        let assignment = optional_amount(p.amount)?;
        let result = if blind {
            self.wallet.blind_receive(
                Some(online),
                p.asset_id,
                assignment,
                expiry,
                p.transport_endpoints,
                p.min_confirmations,
                None,
            )
        } else {
            self.wallet.witness_receive(
                Some(online),
                p.asset_id,
                assignment,
                expiry,
                p.transport_endpoints,
                p.min_confirmations,
                None,
            )
        }
        .map_err(native)?;
        Ok(json!({
            "invoice":result.invoice,
            "recipientId":result.recipient_id,
            "expirationTimestamp":result.expiration_timestamp.to_string(),
            "batchTransferIdx":result.batch_transfer_idx,
            "publicKey":result.public_key,
        }))
    }
    fn burn_begin(&mut self, p: Burn) -> Result<Value> {
        self.idle()?;
        let online = self.online()?;
        require_asset(&p.asset_id)?;
        if !lower_hex(&p.commitment, 64) || p.min_confirmations == 0 {
            return Err(input(
                "Expected a canonical 32-byte burn destination and positive confirmations.",
            ));
        }
        let metadata = self
            .wallet
            .get_asset_metadata(p.asset_id.clone())
            .map_err(native)?;
        if metadata.asset_schema != AssetSchema::Bfa {
            return Err(input(
                "Only a registered BFA asset may use this burn operation.",
            ));
        }
        let amount = positive(&p.amount, u64::MAX)?;
        let plan = self
            .wallet
            .burn_begin(
                online,
                p.asset_id.clone(),
                amount,
                Some(p.commitment.clone()),
                positive(&p.fee_rate, MAX_FEE_RATE)?,
                p.min_confirmations,
                false,
            )
            .map_err(native)?;
        let expected_txid = tx_id(&parse_psbt(&plan.psbt)?);
        let inspection = self
            .wallet
            .inspect_rgb_transfer(
                plan.psbt.clone(),
                plan.details.fascia_path,
                plan.details.entropy,
            )
            .map_err(native)?;
        if burn_matches(
            &inspection,
            &p.asset_id,
            &expected_txid,
            &p.commitment,
            Some(amount),
        ) != Some(amount)
        {
            return Err(fault(
                "UNEXPECTED_BURN_PLAN",
                "The native plan did not commit to the exact requested BFA burn.",
            ));
        }
        self.prepare(Kind::Burn, plan.psbt, plan.batch_transfer_idx)
    }
    fn proof(&self, p: Proof) -> Result<Value> {
        require_asset(&p.asset_id)?;
        require_txid(&p.txid)?;
        if !lower_hex(&p.commitment, 64) {
            return Err(input("Expected a canonical burn destination commitment."));
        }
        let expected_amount = p
            .amount
            .as_deref()
            .map(|a| positive(a, u64::MAX))
            .transpose()?;
        let transfers = self
            .wallet
            .list_transfers(AssetFilter::Id(p.asset_id.clone()), TransferScope::Txid(p.txid.clone()))
            .map_err(|_| proof_error())?;
        let mut matched = transfers.into_iter().filter(|t| {
            t.kind == rgb_lib::wallet::TransferKind::Burn
                && matches!(
                    t.status,
                    TransferStatus::WaitingConfirmations | TransferStatus::Settled
                )
                && t.txid.as_deref() == Some(p.txid.as_str())
        });
        let entry = matched.next().ok_or_else(proof_error)?;
        if matched.next().is_some() {
            return Err(proof_error());
        }
        let stored = PathBuf::from(entry.consignment_path.ok_or_else(proof_error)?);
        let wallet_root = self.wallet.get_wallet_dir();
        let canonical = stored.canonicalize().map_err(|_| proof_error())?;
        if stored != canonical || !canonical.starts_with(&wallet_root) {
            return Err(proof_error());
        }
        let bytes = read_bounded(&canonical, MAX_PROOF).map_err(|_| proof_error())?;
        // Inspect the exact bounded byte buffer that will be exported, not a second read of
        // the mutable source path. The temporary file is private to this call and removed.
        let mut checked = tempfile::NamedTempFile::new_in(&self.root).map_err(storage)?;
        checked.write_all(&bytes).map_err(storage)?;
        let checked_path = checked.path().to_str().ok_or_else(proof_error)?.to_string();
        let inspected = inspect_consignment(checked_path, BundleFilter::Witness(p.txid.clone()))
            .map_err(|_| proof_error())?;
        if !inspected.is_transfer
            || inspected.asset_id != p.asset_id
            || inspected.asset_schema != AssetSchema::Bfa
            || inspected.witnesses.len() != 1
        {
            return Err(proof_error());
        }
        let amount = burn_matches(
            &inspected.witnesses[0],
            &p.asset_id,
            &p.txid,
            &p.commitment,
            expected_amount,
        )
        .ok_or_else(proof_error)?;
        Ok(json!({
            "data":STANDARD.encode(&bytes),
            "sha256":sha256(&bytes),
            "assetId":p.asset_id,
            "txid":p.txid,
            "commitment":p.commitment,
            "amount":amount.to_string(),
        }))
    }
    fn import_contract(&mut self, p: Contract) -> Result<Value> {
        self.idle()?;
        require_asset(&p.expected_asset_id)?;
        if !lower_hex(&p.sha256, 64) || p.contract_base64.len() > MAX_CONTRACT.div_ceil(3) * 4 {
            return Err(input("Invalid contract fingerprint or size."));
        }
        let bytes = STANDARD
            .decode(p.contract_base64)
            .map_err(|_| input("Invalid contract base64."))?;
        if bytes.is_empty() || bytes.len() > MAX_CONTRACT || sha256(&bytes) != p.sha256 {
            return Err(fault(
                "CONTRACT_DIGEST_MISMATCH",
                "Contract bytes do not match their expected SHA-256.",
            ));
        }
        let mut staged = tempfile::NamedTempFile::new_in(&self.root).map_err(storage)?;
        staged.write_all(&bytes).map_err(storage)?;
        let path = staged
            .path()
            .to_str()
            .ok_or_else(|| input("Invalid wallet directory encoding."))?
            .to_string();
        let asset_id = self
            .wallet
            .import_contract(path, Some(p.expected_asset_id))
            .map_err(|e| match e {
                rgb_lib::Error::InvalidConsignment
                | rgb_lib::Error::UnknownRgbSchema { .. }
                | rgb_lib::Error::UnsupportedSchema { .. } => fault(
                    "CONTRACT_FORMAT_UNSUPPORTED",
                    "The contract cannot be decoded or is not a standalone supported RGB contract.",
                ),
                other => native(other),
            })?;
        Ok(json!({"assetId":asset_id}))
    }
    fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        if self.network == BitcoinNetwork::Signet && self.journal_mode == journal::Mode::BtcOnly
            && matches!(method,
                "checkProxyEndpoint" | "refresh" | "blindReceive" | "witnessReceive" |
                "createUtxosBegin" | "createUtxosEnd" | "cancelAbandonedOutputs" |
                "sendRgbBegin" | "sendRgbEnd" | "burnBegin" | "burnEnd" | "importContract")
        {
            return Err(public_signet_btc_only());
        }
        match method {
            "goOnline" => self.go_online(decode(params)?),
            "getNetworkInfo" => self.network_info(params),
            "checkIndexerUrl" => self.check_indexer(params),
            "checkProxyEndpoint" => self.check_proxy(params),
            "getAddress" => {
                let _: Empty = decode(params)?;
                self.idle()?;
                if self.network == BitcoinNetwork::Signet {
                    self.online()?;
                }
                Ok(json!({"address":self.wallet.get_address().map_err(native)?}))
            }
            "getBtcBalance" => {
                let _: Empty = decode(params)?;
                let balance = self
                    .wallet
                    .get_btc_balance(self.online, self.skip_read_sync())
                    .map_err(native)?;
                Ok(
                    json!({"vanilla":iso_balance(balance.vanilla), "colored":iso_balance(balance.colored)}),
                )
            }
            "getAssetBalance" => {
                let p: Asset = decode(params)?;
                require_asset(&p.asset_id)?;
                Ok(iso_balance(
                    self.wallet.get_asset_balance(p.asset_id).map_err(native)?,
                ))
            }
            "getAssetMetadata" => {
                let p: Asset = decode(params)?;
                require_asset(&p.asset_id)?;
                let m = self
                    .wallet
                    .get_asset_metadata(p.asset_id.clone())
                    .map_err(native)?;
                Ok(
                    json!({"assetId":p.asset_id,"schema":m.asset_schema,"name":m.name,"ticker":m.ticker,"precision":m.precision}),
                )
            }
            "listUnspents" => {
                let _: Empty = decode(params)?;
                let rows = self
                    .wallet
                    .list_unspents(self.online, false, self.skip_read_sync())
                    .map_err(native)?;
                Ok(Value::Array(rows.into_iter().map(|row| {
                    let allocations = row.rgb_allocations.into_iter().map(|a| json!({
                        "assetId":a.asset_id,"assignment":assignment_value(&a.assignment),"settled":a.settled,
                    })).collect::<Vec<_>>();
                    json!({
                        "utxo":{
                            "outpoint":row.utxo.outpoint,"btcAmount":row.utxo.btc_amount.to_string(),
                            "colorable":row.utxo.colorable,"exists":row.utxo.exists,"derivationIndex":row.utxo.derivation_index,
                        },
                        "rgbAllocations":allocations,"pendingBlinded":row.pending_blinded,
                    })
                }).collect()))
            }
            "listTransactions" => {
                let _: Empty = decode(params)?;
                let rows = self
                    .wallet
                    .list_transactions(self.online, self.skip_read_sync())
                    .map_err(native)?;
                Ok(Value::Array(rows.into_iter().map(|t| json!({
                    "type":t.transaction_type,"txid":t.txid,"received":t.received.to_string(),
                    "sent":t.sent.to_string(),"fee":t.fee.to_string(),
                    "confirmationTime":t.confirmation_time.map(|c| json!({"height":c.height,"timestamp":c.timestamp.to_string()})),
                })).collect()))
            }
            "listTransfers" => {
                let p: Filter = decode(params)?;
                let filter = if let Some(asset) = p.asset_id {
                    require_asset(&asset)?;
                    AssetFilter::Id(asset)
                } else {
                    AssetFilter::AnyOrNone
                };
                let scope = if let Some(txid) = p.txid {
                    require_txid(&txid)?;
                    TransferScope::Txid(txid)
                } else {
                    TransferScope::All
                };
                let rows = self.wallet.list_transfers(filter, scope).map_err(native)?;
                Ok(Value::Array(rows.into_iter().map(|r| {
                    let change_utxo = match r.change_utxos.as_slice() {
                        [only] => Some(only),
                        _ => None,
                    };
                    json!({
                        "idx":r.idx,"batchTransferIdx":r.batch_transfer_idx,"createdAt":r.created_at.to_string(),
                        "updatedAt":r.updated_at.to_string(),"status":r.status,"kind":r.kind,"txid":r.txid,
                        "recipientId":r.recipient_id,"receiveUtxo":r.receive_utxo,
                        "changeUtxo":change_utxo,"changeUtxos":r.change_utxos,
                        "invoice":r.invoice_string,"expirationTimestamp":r.expiration_timestamp.map(|v| v.to_string()),
                        "assignments":r.assignments.iter().map(assignment_value).collect::<Vec<_>>(),
                        "requestedAssignment":r.requested_assignment.as_ref().map(assignment_value),
                    })
                }).collect()))
            }
            "getFeeRate" => {
                let p: FeeEstimate = decode(params)?;
                if p.blocks == 0 {
                    return Err(input("Block target must be positive."));
                }
                let rate = self
                    .wallet
                    .get_fee_estimation(self.online()?, p.blocks)
                    .map_err(native)?;
                if !rate.is_finite() || rate <= 0.0 || rate > MAX_FEE_RATE as f64 {
                    return Err(fault(
                        "FEE_UNAVAILABLE",
                        "Indexer did not return a usable fee estimate.",
                    ));
                }
                Ok(json!({"feeRate":rate.ceil().to_string()}))
            }
            "decodeInvoice" => {
                let p: InvoiceInput = decode(params)?;
                send::decoded_invoice(&p.invoice)
            }
            "listAssets" => self.assets(params),
            "bindJournal" => self.bind_journal(params),
            "writeJournalRecord" => self.write_journal_record(params),
            "snapshotUnsigned" => self.snapshot_unsigned(params),
            "discardUnsubmitted" => self.discard_unsubmitted(params),
            "cancelAbandonedOutputs" => self.cancel_abandoned_outputs(params),
            "refresh" => self.refresh_transfers(params),
            "blindReceive" => self.receive(decode(params)?, true),
            "witnessReceive" => self.receive(decode(params)?, false),
            "createUtxosBegin" => {
                let p: CreateOutputs = decode(params)?;
                self.idle()?;
                if p.count == 0 || p.count > 32 {
                    return Err(input("Invalid number of RGB outputs."));
                }
                let size = positive(&p.size, u64::from(u32::MAX))? as u32;
                let psbt = self
                    .wallet
                    .create_utxos_begin(
                        self.online()?,
                        false,
                        Some(p.count),
                        Some(size),
                        positive(&p.fee_rate, MAX_FEE_RATE)?,
                        false,
                        false,
                    )
                    .map_err(native)?;
                self.prepare(Kind::Outputs, psbt, None)
            }
            "sendBtcBegin" => self.send_btc_begin(decode(params)?),
            "sendRgbBegin" => self.send_rgb_begin(decode(params)?),
            "getSendStatus" => self.send_status(decode(params)?),
            "burnBegin" => self.burn_begin(decode(params)?),
            "createUtxosEnd" => self.submit(Kind::Outputs, decode(params)?),
            "sendBtcEnd" => self.submit(Kind::Btc, decode(params)?),
            "sendRgbEnd" => self.submit(Kind::Rgb, decode(params)?),
            "burnEnd" => self.submit(Kind::Burn, decode(params)?),
            "discardPrepared" => self.discard_prepared(decode(params)?),
            "getConsignment" => self.proof(decode(params)?),
            "importContract" => self.import_contract(decode(params)?),
            "getReceivedMint" => {
                let p: RecipientId = decode(params)?;
                if p.recipient_id.len() > 512 || RecipientInfo::new(p.recipient_id.clone()).is_err()
                {
                    return Err(input("Invalid invoice recipient ID."));
                }
                Ok(self.wallet.get_received_mint(p.recipient_id).map_err(native)?.map(|m| json!({
                    "opid":m.opid,"lockId":m.lock_id,"amount":m.amount.to_string(),"beforeBlock":m.before_block.to_string(),
                    "evmChainId":m.evm_chain_id.to_string(),"bridgeContract":m.bridge_contract,
                })).unwrap_or(Value::Null))
            }
            _ => Err(fault(
                "METHOD_NOT_SUPPORTED",
                "Operation is not supported by the on-chain wallet.",
            )),
        }
    }
}

fn invoice(raw: &str) -> Result<rgb_lib::wallet::InvoiceData> {
    if raw.len() > 8192 || !raw.starts_with("rgb:") {
        return Err(input("Invalid RGB invoice."));
    }
    Ok(Invoice::new(raw.to_string())
        .map_err(native)?
        .invoice_data())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    params: Value,
}
pub(crate) fn handle_request(worker: &mut Worker, frame: &[u8]) -> Value {
    match serde_json::from_slice::<Request>(frame) {
        Ok(request)
            if request.id.len() <= 80
                && !request.id.is_empty()
                && request
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                && request.method.len() <= 40
                && request.params.is_object() =>
        {
            match worker.dispatch(&request.method, request.params) {
                Ok(result) => json!({"id":request.id,"result":result}),
                Err(error) => json!({"id":request.id,"error":error}),
            }
        }
        _ => json!({"id":null,"error":input("Invalid request envelope.")}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::bitcoin::absolute::LockTime;
    use rgb_lib::bitcoin::transaction::Version;
    use rgb_lib::bitcoin::{Amount, ScriptBuf, Transaction, TxIn, TxOut, Witness};

    const CONTRACT_ID: &str = "rgb:seHWHNYA-~Fy85Df-sLB28o5-EcqC9F8-HW3mUaM-b7kRJgM";
    const CONTRACT_SHA256: &str =
        "60e78d9fc22b69ebd61aafbd37a530f98440cff7b33da5671494790fd3d78be1";
    const CONTRACT: &str = include_str!("../tests/fixtures/regtest-bfa.6.rgb.base64");

    fn open_params(root: &Path, name: &str) -> Value {
        let keys = rgb_lib::keys::generate_keys(chain(name).unwrap(), WitnessVersion::Taproot);
        json!({
            "network":name,
            "dataDir":root,
            "accountXpubVanilla":keys.account_xpub_vanilla,
            "accountXpubColored":keys.account_xpub_colored,
            "masterFingerprint":keys.master_fingerprint,
        })
    }

    #[test]
    fn same_wallet_is_exclusive_and_reopens_without_private_keys() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let params = open_params(dir.path(), "regtest");
        let mut first = Worker::default();
        let mut second = Worker::default();
        assert_eq!(
            first.dispatch("open", params.clone()).unwrap()["watchOnly"],
            true
        );
        let identity: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join(IDENTITY_FILE)).unwrap())
                .unwrap();
        assert_eq!(identity["backend"], BACKEND);
        assert_eq!(
            second.dispatch("open", params.clone()).unwrap_err().code,
            "WALLET_IN_USE"
        );
        assert_eq!(first.dispatch("getBtcBalance", json!({})).unwrap()["vanilla"]["spendable"], "0");
        assert_eq!(first.dispatch("listTransactions", json!({})).unwrap(), json!([]));
        assert_eq!(first.dispatch("listUnspents", json!({})).unwrap(), json!([]));
        let address = first.dispatch("getAddress", json!({})).unwrap();
        assert!(address["address"].as_str().unwrap().starts_with("bcrt1p"));
        let closed = first.dispatch("close", json!({})).unwrap();
        assert_eq!(closed, json!({}));
        assert_eq!(
            first.dispatch("getAddress", json!({})).unwrap_err().code,
            "WALLET_CLOSED"
        );
        let alternate = open_params(dir.path(), "regtest");
        assert_eq!(
            second.dispatch("open", alternate).unwrap_err().code,
            "WALLET_IDENTITY_MISMATCH"
        );
        assert_eq!(second.dispatch("open", params).unwrap()["watchOnly"], true);
        let next = second.dispatch("getAddress", json!({})).unwrap();
        assert_ne!(
            address, next,
            "persisted derivation index must advance after reopen"
        );
    }

    #[test]
    fn bfa5_identity_blocks_wallet_open_before_database_migration() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let params = open_params(dir.path(), "regtest");
        let identity = json!({
            "backend": "rgb-l1-v1",
            "network": "Regtest",
            "accountXpubVanilla": params["accountXpubVanilla"],
            "accountXpubColored": params["accountXpubColored"],
            "masterFingerprint": params["masterFingerprint"],
        });
        let identity_bytes = serde_json::to_vec(&identity).unwrap();
        let identity_path = dir.path().join(IDENTITY_FILE);
        std::fs::write(&identity_path, &identity_bytes).unwrap();
        let wallet_root = dir.path().join(params["masterFingerprint"].as_str().unwrap());
        std::fs::create_dir(&wallet_root).unwrap();
        let legacy_database = wallet_root.join("rgb_lib_db");
        let sentinel = b"old wallet state must remain untouched";
        std::fs::write(&legacy_database, sentinel).unwrap();

        let mut worker = Worker::default();
        assert_eq!(
            worker.dispatch("open", params).unwrap_err().code,
            "WALLET_IDENTITY_MISMATCH"
        );
        assert!(worker.session.is_none());
        assert_eq!(std::fs::read(identity_path).unwrap(), identity_bytes);
        assert_eq!(std::fs::read(legacy_database).unwrap(), sentinel);
        assert_eq!(wallet_root.read_dir().unwrap().count(), 1);
    }

    #[test]
    fn journals_bind_the_native_owner_and_exclude_stale_workers_and_wallet_modes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let params = open_params(dir.path(), "regtest");
        let fields = [
            "network",
            "accountXpubVanilla",
            "accountXpubColored",
            "masterFingerprint",
        ];
        let strings = fields.map(|key| params[key].as_str().unwrap());
        let exact = format!(
            "[\"{}\",\"{}\",\"{}\",\"{}\"]",
            strings[0], strings[1], strings[2], strings[3]
        );
        let identity = sha256(exact.as_bytes());
        let mut first = Worker::default();
        let mut second = Worker::default();
        first.dispatch("open", params.clone()).unwrap();
        assert_eq!(
            first
                .dispatch("bindJournal", json!({"scope":"spend","identity":"other"}))
                .unwrap_err()
                .code,
            "WALLET_IDENTITY_MISMATCH"
        );
        for scope in ["spend", "invoice"] {
            assert_eq!(
                first
                    .dispatch("bindJournal", json!({"scope":scope,"identity":identity}))
                    .unwrap(),
                json!({"written":true})
            );
        }
        let spend = json!({"scope":"spend","record":{"id":"native-journal-send-01","kind":"btc-send","stage":"starting"}});
        let invoice = json!({"scope":"invoice","record":{"id":"native-journal-invoice","kind":"rgb-receive","stage":"submitted"}});
        for request in [&spend, &invoice] {
            assert_eq!(
                first
                    .dispatch("writeJournalRecord", request.clone())
                    .unwrap(),
                json!({"written":true})
            );
        }
        let spend_dir = dir.path().join(".wdk-onchain-journal-v1");
        let identity_meta = spend_dir.join("identity.json").symlink_metadata().unwrap();
        assert_eq!(identity_meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(identity_meta.nlink(), 1);
        let path = spend_dir.join("native-journal-send-01.json");
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
            spend["record"]
        );
        assert_eq!(
            second.dispatch("open", params.clone()).unwrap_err().code,
            "WALLET_IN_USE"
        );
        first.dispatch("close", json!({})).unwrap();
        let mut btc_params = params.clone();
        btc_params["mode"] = "btc-only".into();
        second.dispatch("open", btc_params).unwrap();
        let btc_identity =
            sha256(format!("{},\"btc-only\"]", &exact[..exact.len() - 1]).as_bytes());
        assert_eq!(
            second
                .dispatch(
                    "bindJournal",
                    json!({"scope":"spend","identity":btc_identity})
                )
                .unwrap_err()
                .code,
            "WALLET_MODE_MISMATCH"
        );
        assert_eq!(
            second
                .dispatch("writeJournalRecord", spend.clone())
                .unwrap_err()
                .code,
            "WALLET_MODE_MISMATCH"
        );
        assert_eq!(
            first
                .dispatch("writeJournalRecord", spend)
                .unwrap_err()
                .code,
            "WALLET_CLOSED"
        );
    }

    #[test]
    fn contract_registration_admits_exact_asset_and_chain_without_creating_funds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker::default();
        worker
            .dispatch("open", open_params(dir.path(), "regtest"))
            .unwrap();
        let valid = json!({"contractBase64":CONTRACT.trim(),"expectedAssetId":CONTRACT_ID,"sha256":CONTRACT_SHA256});
        let mut altered = valid.clone();
        altered["sha256"] = "f".repeat(64).into();
        assert_eq!(
            worker.dispatch("importContract", altered).unwrap_err().code,
            "CONTRACT_DIGEST_MISMATCH"
        );
        let mut different = valid.clone();
        different["expectedAssetId"] =
            "rgb:Mh2T02nk-P45ItF~-cSwk40U-Pc2Jx78-zaKBfR0-_7ANkkw".into();
        assert_eq!(
            worker
                .dispatch("importContract", different)
                .unwrap_err()
                .code,
            "CONTRACT_MISMATCH"
        );
        let asset = json!({"assetId":CONTRACT_ID});
        assert_eq!(
            worker
                .dispatch("getAssetBalance", asset.clone())
                .unwrap_err()
                .code,
            "ASSET_NOT_FOUND"
        );
        for _ in 0..2 {
            assert_eq!(
                worker.dispatch("importContract", valid.clone()).unwrap()["assetId"],
                CONTRACT_ID
            );
        }
        assert_eq!(
            worker.dispatch("getAssetMetadata", asset.clone()).unwrap(),
            json!({
                "assetId":CONTRACT_ID,"schema":"Bfa","name":"WDK L1 Qualification BFA","ticker":"QBFA","precision":6,
            })
        );
        assert_eq!(
            worker.dispatch("getAssetBalance", asset.clone()).unwrap(),
            json!({"settled":"0","future":"0","spendable":"0"})
        );
        assert_eq!(worker.dispatch("listTransfers", asset).unwrap(), json!([]));

        let second = tempfile::tempdir().unwrap();
        std::fs::set_permissions(second.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut wrong_chain = Worker::default();
        let mut params = open_params(second.path(), "signet");
        params["mode"] = json!("btc-only");
        wrong_chain.dispatch("open", params).unwrap();
        let contract = decode(valid).unwrap();
        assert!(wrong_chain.session.as_mut().unwrap().import_contract(contract).is_err());
    }

    #[test]
    fn indexer_missing_fee_estimate_is_reported_as_unavailable() {
        assert_eq!(native(rgb_lib::Error::CannotEstimateFees).code, "FEE_UNAVAILABLE");
    }

    #[test]
    fn bfa5_regtest_contract_is_rejected_without_registration() {
        const LEGACY_ID: &str = "rgb:rkMVlCDS-TPWWQZK-1Sg4G77-076Bqzl-a6SHf5U-WlnW1yA";
        const LEGACY_SHA: &str = "7eabc7ff78e046ad2b6f26e1d61b5c151ffa53870ced7001bc2a15c80ddfd3f8";
        const LEGACY_CONTRACT: &str = include_str!("../tests/fixtures/regtest-bfa.5.rgb.base64");
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker::default();
        worker.dispatch("open", open_params(dir.path(), "regtest")).unwrap();
        let request = json!({
            "contractBase64": LEGACY_CONTRACT.trim(),
            "expectedAssetId": LEGACY_ID,
            "sha256": LEGACY_SHA,
        });
        assert_eq!(
            worker.dispatch("importContract", request).unwrap_err().code,
            "CONTRACT_FORMAT_UNSUPPORTED"
        );
        assert_eq!(
            worker.dispatch("getAssetBalance", json!({"assetId": LEGACY_ID})).unwrap_err().code,
            "ASSET_NOT_FOUND"
        );
    }

    #[test]
    fn public_signet_native_open_and_mutations_require_bitcoin_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker::default();
        let mut params = open_params(dir.path(), "signet");
        assert_eq!(worker.dispatch("open", params.clone()).unwrap_err().code, "RGB_MODE_UNAVAILABLE");
        params["mode"] = json!("btc-only");
        assert_eq!(worker.dispatch("open", params).unwrap()["network"], "signet");

        assert_eq!(worker.dispatch("goOnline", json!({
            "indexerUrl": "ssl://electrum.iriswallet.com:50033",
            "evmRpcUrls": {"42161": "https://example.test"},
        })).unwrap_err().code, "INVALID_PARAMS");
        assert_eq!(worker.dispatch("goOnline", json!({
            "indexerUrl": "tcp://127.0.0.1:50001",
        })).unwrap_err().code, "INVALID_PARAMS");
        assert_eq!(worker.dispatch("getAddress", json!({})).unwrap_err().code, "WALLET_OFFLINE");
        for method in ["checkProxyEndpoint", "importContract", "createUtxosBegin", "refresh", "sendRgbBegin", "burnBegin"] {
            assert_eq!(worker.dispatch(method, json!({})).unwrap_err().code, "RGB_MODE_UNAVAILABLE");
        }
        assert_eq!(worker.dispatch("discardUnsubmitted", json!({
            "kind": "rgb-output", "checkpoint": [],
        })).unwrap_err().code, "RGB_MODE_UNAVAILABLE");
    }

    #[test]
    fn disabled_dev_signet_cannot_open_wallet_or_admit_any_hosted_service() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut params = open_params(dir.path(), "signet");
        params["profile"] = json!("dev");
        let mut worker = Worker::default();
        let mut wrong_mode = params.clone();
        wrong_mode["mode"] = json!("btc-only");
        assert_eq!(worker.dispatch("open", wrong_mode).unwrap_err().code, "INVALID_PARAMS");
        assert!(worker.session.is_none());
        assert!(dir.path().read_dir().unwrap().next().is_none());
        let error = worker.dispatch("open", params).unwrap_err();
        assert_eq!(error.code, "INVALID_PARAMS");
        assert_eq!(error.message, "Dev Signet hosted access is disabled.");
        assert!(worker.session.is_none());
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }

    #[test]
    #[ignore = "requires the BUSDT contract recovered from Dev E2E run 41698713237"]
    fn recovered_bfa5_dev_busdt_is_rejected_offline() {
        let id = "rgb:fbkO6B_i-qyLXa6d-x3sAOaX-cx~vZB9-rxNSUle-9lXBTf8";
        let digest = "a678ebf73f3a0523b307cd2fe8019a321ac938eaf547c2c65a7ac079948332ce";
        let bytes = std::fs::read(std::env::var_os("UTEXO_DEV_BUSDT_CONTRACT").unwrap()).unwrap();
        assert_eq!(sha256(&bytes), digest);
        let request = json!({"contractBase64":STANDARD.encode(bytes),"expectedAssetId":id,"sha256":digest});
        let asset = json!({"assetId":id});

        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker::default();
        let mut params = open_params(dir.path(), "signet");
        // Exercise the contract decoder on the same Bitcoin network independently
        // of the earlier public dispatch and disabled Dev profile gates.
        params["mode"] = json!("btc-only");
        worker.dispatch("open", params).unwrap();
        let contract = decode(request).unwrap();
        assert_eq!(
            worker.session.as_mut().unwrap().import_contract(contract).unwrap_err().code,
            "CONTRACT_FORMAT_UNSUPPORTED"
        );
        assert_eq!(
            worker.dispatch("getAssetBalance", asset).unwrap_err().code,
            "ASSET_NOT_FOUND"
        );
    }

    #[test]
    fn malformed_contract_is_rejected_without_registration() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Worker::default();
        worker
            .dispatch("open", open_params(dir.path(), "regtest"))
            .unwrap();
        let mut bytes = STANDARD.decode(CONTRACT.trim()).unwrap();
        bytes.truncate(16);
        let digest = sha256(&bytes);
        let request = json!({
            "contractBase64": STANDARD.encode(bytes),
            "expectedAssetId": CONTRACT_ID,
            "sha256": digest,
        });
        assert_eq!(
            worker.dispatch("importContract", request).unwrap_err().code,
            "CONTRACT_FORMAT_UNSUPPORTED"
        );
        assert_eq!(
            worker
                .dispatch("getAssetBalance", json!({"assetId": CONTRACT_ID}))
                .unwrap_err()
                .code,
            "ASSET_NOT_FOUND"
        );
    }

    #[test]
    fn exact_plan_preserves_all_unsigned_transaction_and_psbt_metadata() {
        let mut psbt = Psbt::from_unsigned_tx(Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn::default()],
            output: vec![TxOut {
                value: Amount::from_sat(1000),
                script_pubkey: ScriptBuf::new(),
            }],
        })
        .unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(1100),
            script_pubkey: ScriptBuf::new(),
        });
        let expected = Prepared {
            kind: Kind::Btc,
            txid: tx_id(&psbt),
            psbt: psbt.clone(),
            batch_idx: None,
            discard_requested: false,
        };
        assert!(assert_signed_plan(&expected, &psbt).is_err());
        psbt.inputs[0].final_script_witness = Some(Witness::from_slice(&[[7u8; 64]]));
        assert!(assert_signed_plan(&expected, &psbt).is_ok());
        let mut changed = psbt.clone();
        changed.inputs[0].witness_utxo.as_mut().unwrap().value = Amount::from_sat(1200);
        assert!(assert_signed_plan(&expected, &changed).is_err());
        let mut changed = psbt.clone();
        changed.unsigned_tx.output[0].value = Amount::from_sat(1001);
        assert!(assert_signed_plan(&expected, &changed).is_err());
        psbt.inputs[0].final_script_witness = Some(Witness::from_slice(&[[7u8; 65]]));
        assert!(assert_signed_plan(&expected, &psbt).is_err());
    }

    #[test]
    fn ipc_rejects_numeric_amounts_mnemonics_and_credentials_are_not_echoed() {
        assert_eq!(exact("18446744073709551615", u64::MAX).unwrap(), u64::MAX);
        for invalid in ["18446744073709551616", "001", "-1", "1.0", "1e9", ""] {
            assert!(exact(invalid, u64::MAX).is_err());
        }
        let request = concat!(
            "{\"id\":\"r1\",\"method\":\"version\",\"params\":{}}\n",
            "{\"id\":\"r2\",\"method\":\"open\",\"params\":{\"mnemonic\":\"secret-sentinel\"}}\n",
            "{\"id\":\"r3\",\"method\":\"burnEnd\",\"params\":{}}\n",
        );
        let mut worker = Worker::default();
        let lines: Vec<Value> = request
            .lines()
            .map(|line| handle_request(&mut worker, line.as_bytes()))
            .collect();
        assert!(
            !serde_json::to_string(&lines)
                .unwrap()
                .contains("secret-sentinel")
        );
        assert_eq!(lines[0]["result"]["overlayTree"], OVERLAY);
        assert_eq!(lines[1]["error"]["code"], "INVALID_PARAMS");
        assert_eq!(lines[2]["error"]["code"], "WALLET_CLOSED");
    }
}
