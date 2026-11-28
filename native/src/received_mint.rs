// SPDX-License-Identifier: Apache-2.0
//! Pre-payment mint inspection, anchored to the wallet's checked receive.
use super::{
    Result, Session, Value, decode, fault, input, invoice, json, lower_hex, native, read_bounded,
    require_asset, storage,
};
use rgb_lib::no_wallet::{BundleFilter, inspect_consignment};
use rgb_lib::wallet::{
    AssetFilter, InvoiceData, ReceivedMint, RefreshFilter, RefreshTransferStatus,
    RgbTransitionInfo, RgbWalletOpsOffline, RgbWalletOpsOnline, Transfer, TransferKind,
    TransferScope, TransitionGlobal, TransitionMetadata,
};
use rgb_lib::{
    AssetSchema, Assignment, BitcoinNetwork, ConsignmentExt, FileContent, LockId, RgbTransfer,
    TransferStatus, TypeOfTransition,
};
use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_RECEIVED_CONSIGNMENT: usize = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    invoice: String,
    expected_asset_id: Option<String>,
}

fn unavailable() -> super::Fault {
    fault(
        "MINT_VERIFICATION_UNAVAILABLE",
        "The received mint cannot currently be verified for this invoice.",
    )
}

// WDK creates one-use invoices with fresh witness addresses. Never pick a mint
// arbitrarily if an externally produced/reused invoice resolves more than one.
pub(super) fn single_mint(mut mints: Vec<ReceivedMint>) -> Result<Option<ReceivedMint>> {
    if mints.len() > 1 {
        return Err(unavailable());
    }
    Ok(mints.pop())
}

fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| unavailable())
}

fn receive_identity(
    transfer: &Transfer,
    raw: &str,
    parsed: &InvoiceData,
    network: BitcoinNetwork,
    time: u64,
) -> Result<()> {
    if !matches!(
        transfer.kind,
        TransferKind::ReceiveBlind | TransferKind::ReceiveWitness
    ) || transfer.status == TransferStatus::Failed
        || transfer.invoice_string.as_deref() != Some(raw)
        || transfer.recipient_id.as_deref() != Some(parsed.recipient_id.as_str())
        || parsed.network != network
        || parsed
            .expiration_timestamp
            .is_none_or(|expiry| expiry <= time)
        || parsed.transport_endpoints.is_empty()
        || !parsed
            .public_key
            .as_ref()
            .is_some_and(|key| lower_hex(key, 64))
    {
        return Err(unavailable());
    }
    Ok(())
}

fn check_mint_fields(mint: &ReceivedMint, parsed: &InvoiceData) -> Result<()> {
    if !lower_hex(&mint.opid, 64)
        || !lower_hex(&mint.lock_id, 64)
        || mint.amount == 0
        || mint.before_block == 0
        || mint.evm_chain_id == 0
        || !mint
            .bridge_contract
            .strip_prefix("0x")
            .is_some_and(|address| lower_hex(address, 40))
        || !matches!(parsed.assignment, Assignment::Any | Assignment::Fungible(0))
            && parsed.assignment != Assignment::Fungible(mint.amount)
    {
        return Err(unavailable());
    }
    Ok(())
}

fn check_transition(transition: &RgbTransitionInfo, mint: &ReceivedMint) -> Result<()> {
    let issued: Vec<_> = transition
        .globals
        .iter()
        .filter_map(|value| match value {
            TransitionGlobal::IssuedSupply(amount) => Some(*amount),
            _ => None,
        })
        .collect();
    let deadlines: Vec<_> = transition
        .metadata
        .iter()
        .filter_map(|value| match value {
            TransitionMetadata::BeforeBlock(block) => Some(*block),
            _ => None,
        })
        .collect();
    let amount = transition
        .outputs
        .iter()
        .try_fold(0u64, |sum, output| match output.assignment {
            Assignment::Fungible(amount) => sum.checked_add(amount),
            _ => Some(sum),
        })
        .ok_or_else(unavailable)?;
    if transition.opid != mint.opid
        || transition.r#type != TypeOfTransition::Mint
        || deadlines.as_slice() != [mint.before_block]
        || issued.as_slice() != [mint.amount]
        || amount != mint.amount
    {
        return Err(unavailable());
    }
    Ok(())
}

impl Session {
    fn mint_receive(&self, request: &Request, parsed: &InvoiceData) -> Result<Transfer> {
        let rows = self
            .wallet
            .list_transfers(AssetFilter::AnyOrNone, TransferScope::All)
            .map_err(native)?;
        let mut matching = rows.into_iter().filter(|transfer| {
            transfer.recipient_id.as_deref() == Some(parsed.recipient_id.as_str())
        });
        let transfer = matching.next().ok_or_else(unavailable)?;
        if matching.next().is_some() {
            return Err(unavailable());
        }
        receive_identity(&transfer, &request.invoice, parsed, self.network, now()?)?;
        Ok(transfer)
    }

    pub(super) fn received_mint_for_invoice(&mut self, params: Value) -> Result<Value> {
        let request: Request = decode(params)?;
        let parsed = invoice(&request.invoice)?;
        if let Some(expected) = &request.expected_asset_id {
            require_asset(expected)?;
            if parsed
                .asset_id
                .as_ref()
                .is_some_and(|asset| asset != expected)
            {
                return Err(input("The invoice requests a different RGB asset."));
            }
        }
        self.idle()?;
        let before = self.mint_receive(&request, &parsed)?;
        self.check_online_chain()?;
        // Only refresh incoming transfers. Reading a mint must not replay an outgoing send
        // or initiate a payment. Stock RGB performs receipt validation and lock checks.
        let refreshed = self
            .wallet
            .refresh(
                self.online()?,
                None,
                vec![
                    RefreshFilter {
                        status: RefreshTransferStatus::WaitingCounterparty,
                        incoming: true,
                    },
                    RefreshFilter {
                        status: RefreshTransferStatus::WaitingSafeHeight,
                        incoming: true,
                    },
                    RefreshFilter {
                        status: RefreshTransferStatus::WaitingBroadcast,
                        incoming: true,
                    },
                    RefreshFilter {
                        status: RefreshTransferStatus::WaitingConfirmations,
                        incoming: true,
                    },
                ],
                false,
            )
            .map_err(native)?;
        if refreshed
            .get(&before.batch_transfer_idx)
            .is_some_and(|result| result.failure.is_some())
        {
            return Err(unavailable());
        }
        let transfer = self.mint_receive(&request, &parsed)?;
        let Some(mint) = single_mint(
            self.wallet
                .get_received_mint(parsed.recipient_id.clone())
                .map_err(native)?,
        )?
        else {
            return if transfer.status == TransferStatus::Settled {
                Err(unavailable())
            } else {
                Ok(Value::Null)
            };
        };
        check_mint_fields(&mint, &parsed)?;
        let stored = PathBuf::from(transfer.consignment_path.ok_or_else(unavailable)?);
        let canonical = stored.canonicalize().map_err(|_| unavailable())?;
        if stored != canonical || !canonical.starts_with(self.wallet.get_wallet_dir()) {
            return Err(unavailable());
        }
        let bytes =
            read_bounded(&canonical, MAX_RECEIVED_CONSIGNMENT).map_err(|_| unavailable())?;
        let mut snapshot = tempfile::NamedTempFile::new_in(&self.root).map_err(storage)?;
        snapshot.write_all(&bytes).map_err(storage)?;
        let path = snapshot.path().to_str().ok_or_else(unavailable)?.to_owned();
        let consignment = RgbTransfer::load_file(&path).map_err(|_| unavailable())?;
        let asset_id = consignment.contract_id().to_string();
        if BitcoinNetwork::try_from(consignment.genesis.chain_net).map_err(|_| unavailable())?
            != self.network
            || parsed
                .asset_id
                .as_ref()
                .is_some_and(|asset| asset != &asset_id)
            || request
                .expected_asset_id
                .as_ref()
                .is_some_and(|asset| asset != &asset_id)
        {
            return Err(unavailable());
        }
        // A checked receipt proves which operation pays this recipient. The operation ID
        // commits its contract ID; its LockId also commits the Bitcoin witness transaction.
        // Inspecting an arbitrary consignment without this receipt proves neither fact.
        let checked_opid = &mint.opid;
        let mut matched = consignment.bundles.iter().flat_map(|bundle| {
            bundle
                .bundle
                .known_transitions
                .iter()
                .filter_map(move |known| {
                    (known.opid.to_string() == *checked_opid).then_some((bundle, known))
                })
        });
        let (bundle, known) = matched.next().ok_or_else(unavailable)?;
        if matched.next().is_some()
            || known.transition.contract_id != consignment.contract_id()
            || LockId::with(known.opid, bundle.witness_id()).to_string() != mint.lock_id
        {
            return Err(unavailable());
        }
        let txid = bundle.witness_id().to_string();
        if transfer.txid.as_ref().is_some_and(|stored| stored != &txid) {
            return Err(unavailable());
        }
        let inspected = inspect_consignment(path, BundleFilter::Witness(txid.clone()))
            .map_err(|_| unavailable())?;
        if !inspected.is_transfer
            || inspected.asset_schema != AssetSchema::Bfa
            || inspected.asset_id != asset_id
            || inspected.witnesses.len() != 1
        {
            return Err(unavailable());
        }
        let transitions = &inspected.witnesses[0].operations;
        let mut paying = transitions
            .iter()
            .filter(|operation| operation.asset_id == asset_id)
            .flat_map(|operation| &operation.transitions)
            .filter(|transition| transition.opid == mint.opid);
        let transition = paying.next().ok_or_else(unavailable)?;
        if paying.next().is_some() {
            return Err(unavailable());
        }
        check_transition(transition, &mint)?;
        // Nothing is cached as an authorization result. Recheck the receive after inspection
        // and reject a stale/failed receipt even if its old file remains on disk.
        self.mint_receive(&request, &parsed)?;
        if single_mint(
            self.wallet
                .get_received_mint(parsed.recipient_id.clone())
                .map_err(native)?,
        )?
        .as_ref()
            != Some(&mint)
        {
            return Err(unavailable());
        }
        Ok(json!({
            "invoice": request.invoice, "recipientId": parsed.recipient_id,
            "assetId": asset_id, "network": self.network.to_string().to_lowercase(), "txid": txid,
            "opid": mint.opid, "lockId": mint.lock_id, "amount": mint.amount.to_string(),
            "beforeBlock": mint.before_block.to_string(), "evmChainId": mint.evm_chain_id.to_string(),
            "bridgeContract": mint.bridge_contract,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::Encryption;
    use rgb_lib::wallet::RgbOutputInfo;
    use std::collections::HashMap;

    fn fixture() -> (Transfer, InvoiceData, ReceivedMint) {
        let parsed = InvoiceData {
            recipient_id: "local-recipient".into(),
            asset_schema: None,
            asset_id: None,
            assignment: Assignment::Any,
            assignment_name: Some("assetOwner".into()),
            network: BitcoinNetwork::Regtest,
            expiration_timestamp: Some(200),
            transport_endpoints: vec!["rpc://127.0.0.1:3000/json-rpc".into()],
            public_key: Some("11".repeat(32)),
            encryption: Encryption::Required,
            unknown_query_params: HashMap::new(),
        };
        let transfer = Transfer {
            idx: 1,
            batch_transfer_idx: 2,
            created_at: 100,
            updated_at: 100,
            status: TransferStatus::WaitingCounterparty,
            requested_assignment: None,
            assignments: vec![],
            kind: TransferKind::ReceiveBlind,
            txid: None,
            recipient_id: Some(parsed.recipient_id.clone()),
            receive_utxo: None,
            change_utxos: vec![],
            expiration_timestamp: Some(200),
            transport_endpoints: vec![],
            sender_transport_endpoint: None,
            invoice_string: Some("rgb:exact-local-invoice".into()),
            consignment_path: None,
            psbt_path: None,
        };
        let mint = ReceivedMint {
            opid: "12".repeat(32),
            lock_id: "34".repeat(32),
            amount: 1000,
            before_block: 180,
            evm_chain_id: 31337,
            bridge_contract: format!("0x{}", "56".repeat(20)),
        };
        (transfer, parsed, mint)
    }

    #[test]
    fn one_use_mint_receipt_does_not_select_from_ambiguous_results() {
        let (_, _, mint) = fixture();
        assert!(single_mint(vec![]).unwrap().is_none());
        assert_eq!(single_mint(vec![mint.clone()]).unwrap(), Some(mint.clone()));
        assert_eq!(
            single_mint(vec![mint.clone(), mint]).unwrap_err().code,
            "MINT_VERIFICATION_UNAVAILABLE"
        );
    }

    #[test]
    fn receive_requires_exact_stored_invoice_and_live_local_identity() {
        let (transfer, parsed, _) = fixture();
        let raw = transfer.invoice_string.as_ref().unwrap();
        assert!(receive_identity(&transfer, raw, &parsed, BitcoinNetwork::Regtest, 150).is_ok());
        // Any edit to amount, proxy, public key, expiry or another query changes the exact
        // stored string, even when its recipient ID remains identical.
        for replacement in [
            "rgb:foreign",
            "rgb:exact-local-invoice?pk=changed",
            "rgb:exact-local-invoice?amount=1",
        ] {
            assert!(
                receive_identity(
                    &transfer,
                    replacement,
                    &parsed,
                    BitcoinNetwork::Regtest,
                    150
                )
                .is_err()
            );
        }
        for time in [200, 201, u64::MAX] {
            assert!(
                receive_identity(&transfer, raw, &parsed, BitcoinNetwork::Regtest, time).is_err()
            );
        }
        assert!(receive_identity(&transfer, raw, &parsed, BitcoinNetwork::Signet, 150).is_err());
        for replacement in [
            TransferKind::Send,
            TransferKind::Burn,
            TransferKind::Mint,
            TransferKind::Issuance,
        ] {
            let mut other = transfer.clone();
            other.kind = replacement;
            assert!(receive_identity(&other, raw, &parsed, BitcoinNetwork::Regtest, 150).is_err());
        }
        let mut failed = transfer.clone();
        failed.status = TransferStatus::Failed;
        assert!(receive_identity(&failed, raw, &parsed, BitcoinNetwork::Regtest, 150).is_err());
        let mut foreign = parsed.clone();
        foreign.recipient_id = "other-recipient".into();
        assert!(receive_identity(&transfer, raw, &foreign, BitcoinNetwork::Regtest, 150).is_err());
        let mut no_key = parsed.clone();
        no_key.public_key = None;
        assert!(receive_identity(&transfer, raw, &no_key, BitcoinNetwork::Regtest, 150).is_err());
    }

    #[test]
    fn receipt_amount_must_pay_requested_invoice_exactly() {
        let (_, mut parsed, mint) = fixture();
        for assignment in [
            Assignment::Any,
            Assignment::Fungible(0),
            Assignment::Fungible(1000),
        ] {
            parsed.assignment = assignment;
            assert!(check_mint_fields(&mint, &parsed).is_ok());
        }
        for assignment in [Assignment::Fungible(1), Assignment::MintRight] {
            parsed.assignment = assignment;
            assert!(check_mint_fields(&mint, &parsed).is_err());
        }
        parsed.assignment = Assignment::Any;
        for field in 0..6 {
            let mut invalid = mint.clone();
            match field {
                0 => invalid.amount = 0,
                1 => invalid.before_block = 0,
                2 => invalid.evm_chain_id = 0,
                3 => invalid.lock_id.clear(),
                4 => invalid.opid.clear(),
                _ => invalid.bridge_contract.clear(),
            }
            assert!(check_mint_fields(&invalid, &parsed).is_err());
        }
    }

    #[test]
    fn inspected_mint_terms_must_match_checked_receipt_without_overflow() {
        let (_, _, mint) = fixture();
        let transition = RgbTransitionInfo {
            r#type: TypeOfTransition::Mint,
            opid: mint.opid.clone(),
            inputs: vec![],
            globals: vec![TransitionGlobal::IssuedSupply(mint.amount)],
            metadata: vec![TransitionMetadata::BeforeBlock(mint.before_block)],
            outputs: vec![RgbOutputInfo {
                txid: None,
                vout: None,
                blinding: None,
                assignment: Assignment::Fungible(mint.amount),
                is_concealed: true,
                recipient_id: None,
                is_ours: None,
                is_terminal: Some(true),
            }],
        };
        assert!(check_transition(&transition, &mint).is_ok());
        for field in 0..6 {
            let mut invalid = transition.clone();
            match field {
                0 => invalid.opid = "ab".repeat(32),
                1 => invalid.r#type = TypeOfTransition::Burn,
                2 => invalid.metadata.clear(),
                3 => invalid
                    .metadata
                    .push(TransitionMetadata::BeforeBlock(mint.before_block)),
                4 => invalid.outputs[0].assignment = Assignment::Fungible(mint.amount + 1),
                _ => {
                    invalid.outputs[0].assignment = Assignment::Fungible(u64::MAX);
                    invalid.outputs.push(invalid.outputs[0].clone());
                }
            }
            assert!(check_transition(&invalid, &mint).is_err());
        }
    }
}
