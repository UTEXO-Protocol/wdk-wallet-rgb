// SPDX-License-Identifier: Apache-2.0
//! Exact, expired ordinary-invoice cancellation using the public BFA.8 API.
//!
//! The worker serializes requests while owning the wallet directory. BFA.8 performs its
//! refresh, proxy retention checks and failure in a database transaction. These checks use
//! upstream's retention/data-loss policy; this adapter does not claim authenticated proof
//! that a proxy has never held a consignment.
use super::{CancelReceive, Result, Session, Value, fault, input, json};
use rgb_lib::wallet::{
    AssetFilter, Invoice, InvoiceData, RecipientInfo, RefreshFilter, RefreshTransferStatus,
    RgbWalletOpsOffline, RgbWalletOpsOnline, Transfer, TransferKind, TransferScope,
};
use rgb_lib::{AssetSchema, BitcoinNetwork, TransferStatus};
use std::time::{SystemTime, UNIX_EPOCH};

fn unavailable() -> super::Fault {
    fault(
        "RECEIVE_CANCELLATION_UNAVAILABLE",
        "The expired receive invoice cannot currently be cancelled. Refresh its status and retry.",
    )
}

fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs())
}

fn unused_receive(transfer: &Transfer) -> bool {
    matches!(
        transfer.kind,
        TransferKind::ReceiveBlind | TransferKind::ReceiveWitness
    ) && transfer.txid.is_none()
        && transfer.consignment_path.is_none()
        && transfer.sender_transport_endpoint.is_none()
        && transfer.psbt_path.is_none()
        && transfer.change_utxos.is_empty()
}

fn identity(
    transfer: &Transfer,
    invoice: &InvoiceData,
    recipient_id: &str,
    network: BitcoinNetwork,
    now: u64,
) -> Option<(String, AssetSchema)> {
    let schema = invoice.asset_schema?;
    let asset_id = invoice.asset_id.as_ref()?;
    let expiry = transfer.expiration_timestamp?;
    let created = u64::try_from(transfer.created_at).ok()?;
    // An arbitrary-asset invoice may receive a mint, whose lock outlives invoice expiry.
    // Limit this operation to an explicitly identified ordinary asset.
    if !matches!(schema, AssetSchema::Nia | AssetSchema::Cfa)
        || !unused_receive(transfer)
        || !matches!(
            transfer.status,
            TransferStatus::WaitingCounterparty | TransferStatus::Failed
        )
        || transfer.recipient_id.as_deref() != Some(recipient_id)
        || invoice.recipient_id != recipient_id
        || invoice.network != network
        || invoice.expiration_timestamp != Some(expiry)
        || expiry <= created
        || expiry >= now
        || invoice.transport_endpoints.is_empty()
        || !invoice
            .public_key
            .as_ref()
            .is_some_and(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return None;
    }
    Some((asset_id.clone(), schema))
}

/// Display eligibility is an observation, not authorization to mutate. The mutation rereads
/// the exact batch, validates its asset and refreshes delivery state before invoking upstream.
pub(super) fn eligible(transfer: &Transfer, network: BitcoinNetwork) -> bool {
    if transfer.status != TransferStatus::WaitingCounterparty {
        return false;
    }
    let (Some(raw), Some(recipient), Some(now)) =
        (&transfer.invoice_string, &transfer.recipient_id, now())
    else {
        return false;
    };
    Invoice::new(raw.clone()).ok().is_some_and(|invoice| {
        identity(transfer, &invoice.invoice_data(), recipient, network, now).is_some()
    })
}

impl Session {
    fn receive_for_cancellation(&self, request: &CancelReceive) -> Result<Transfer> {
        let rows = self
            .wallet
            .list_transfers(
                AssetFilter::AnyOrNone,
                TransferScope::BatchTransfer(request.batch_transfer_idx),
            )
            .map_err(|error| match error {
                rgb_lib::Error::BatchTransferNotFound { .. } => fault(
                    "RECEIVE_NOT_FOUND",
                    "The exact receive invoice was not found.",
                ),
                _ => unavailable(),
            })?;
        let [transfer] = rows.as_slice() else {
            return Err(unavailable());
        };
        if transfer.batch_transfer_idx != request.batch_transfer_idx
            || transfer.recipient_id.as_deref() != Some(&request.recipient_id)
        {
            return Err(fault(
                "RECEIVE_NOT_FOUND",
                "The exact receive invoice was not found.",
            ));
        }
        Ok(transfer.clone())
    }

    fn cancellation_identity(
        &self,
        transfer: &Transfer,
        request: &CancelReceive,
    ) -> Result<String> {
        let raw = transfer.invoice_string.as_ref().ok_or_else(unavailable)?;
        let invoice = Invoice::new(raw.clone())
            .map_err(|_| unavailable())?
            .invoice_data();
        let (asset_id, schema) = identity(
            transfer,
            &invoice,
            &request.recipient_id,
            self.network,
            now().ok_or_else(unavailable)?,
        )
        .ok_or_else(unavailable)?;
        let metadata = self
            .wallet
            .get_asset_metadata(asset_id.clone())
            .map_err(|_| unavailable())?;
        if metadata.asset_schema != schema {
            return Err(unavailable());
        }
        Ok(asset_id)
    }

    pub(super) fn cancel_receive(&mut self, request: CancelReceive) -> Result<Value> {
        if request.batch_transfer_idx <= 0
            || request.recipient_id.len() > 512
            || RecipientInfo::new(request.recipient_id.clone()).is_err()
        {
            return Err(input("Invalid RGB receive invoice identity."));
        }
        self.idle()?;
        let online = self.online()?;
        let transfer = self.receive_for_cancellation(&request)?;
        let asset_id = self.cancellation_identity(&transfer, &request)?;
        // A committed failure survives process restart. Retrying the same exact identity is
        // read-only; it cannot cancel another invoice or repeat a financial operation.
        if transfer.status == TransferStatus::Failed {
            return Ok(json!({"cancelled": true}));
        }
        let refreshed = self
            .wallet
            .refresh(
                online,
                Some(asset_id),
                vec![RefreshFilter {
                    status: RefreshTransferStatus::WaitingCounterparty,
                    incoming: true,
                }],
                false,
            )
            .map_err(|_| unavailable())?;
        if refreshed
            .get(&request.batch_transfer_idx)
            .is_some_and(|result| result.failure.is_some())
        {
            return Err(unavailable());
        }
        let transfer = self.receive_for_cancellation(&request)?;
        self.cancellation_identity(&transfer, &request)?;
        if transfer.status != TransferStatus::Failed {
            self.wallet
                .fail_transfers(online, Some(request.batch_transfer_idx), false, false)
                .map_err(|_| unavailable())?;
        }
        let transfer = self.receive_for_cancellation(&request)?;
        self.cancellation_identity(&transfer, &request)?;
        if transfer.status != TransferStatus::Failed {
            return Err(unavailable());
        }
        Ok(json!({"cancelled": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::{Assignment, Encryption};
    use std::collections::HashMap;

    fn ordinary() -> (Transfer, InvoiceData) {
        let recipient = "recipient".to_owned();
        let invoice = InvoiceData {
            recipient_id: recipient.clone(),
            asset_schema: Some(AssetSchema::Nia),
            asset_id: Some("asset".into()),
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
            recipient_id: Some(recipient),
            receive_utxo: None,
            change_utxos: vec![],
            expiration_timestamp: Some(200),
            transport_endpoints: vec![],
            sender_transport_endpoint: None,
            invoice_string: None,
            consignment_path: None,
            psbt_path: None,
        };
        (transfer, invoice)
    }

    fn admitted(transfer: &Transfer, invoice: &InvoiceData) -> bool {
        identity(transfer, invoice, "recipient", BitcoinNetwork::Regtest, 201).is_some()
    }

    #[test]
    fn permits_expired_nia_and_cfa_blind_or_witness_and_exact_failed_retry() {
        for schema in [AssetSchema::Nia, AssetSchema::Cfa] {
            for kind in [TransferKind::ReceiveBlind, TransferKind::ReceiveWitness] {
                for status in [TransferStatus::WaitingCounterparty, TransferStatus::Failed] {
                    let (mut transfer, mut invoice) = ordinary();
                    invoice.asset_schema = Some(schema);
                    transfer.kind = kind.clone();
                    transfer.status = status;
                    assert!(admitted(&transfer, &invoice));
                }
            }
        }
    }

    #[test]
    fn rejects_live_or_mismatched_expiration_recipient_network_and_ambiguous_assets() {
        let (transfer, invoice) = ordinary();
        for timestamp in [0, 100, 199, 200] {
            assert!(
                identity(
                    &transfer,
                    &invoice,
                    "recipient",
                    BitcoinNetwork::Regtest,
                    timestamp
                )
                .is_none()
            );
        }
        assert!(identity(&transfer, &invoice, "other", BitcoinNetwork::Regtest, 201).is_none());
        assert!(
            identity(
                &transfer,
                &invoice,
                "recipient",
                BitcoinNetwork::Signet,
                201
            )
            .is_none()
        );
        for schema in [
            None,
            Some(AssetSchema::Bfa),
            Some(AssetSchema::Ifa),
            Some(AssetSchema::Uda),
        ] {
            let mut altered = invoice.clone();
            altered.asset_schema = schema;
            assert!(!admitted(&transfer, &altered));
        }
        let mut altered = invoice.clone();
        altered.asset_id = None;
        assert!(!admitted(&transfer, &altered));
        altered = invoice.clone();
        altered.expiration_timestamp = Some(199);
        assert!(!admitted(&transfer, &altered));
        altered = invoice.clone();
        altered.recipient_id = "other".into();
        assert!(!admitted(&transfer, &altered));
    }

    #[test]
    fn rejects_started_delivery_and_non_receive_operations() {
        let (transfer, invoice) = ordinary();
        for status in [
            TransferStatus::Initiated,
            TransferStatus::WaitingSafeHeight,
            TransferStatus::WaitingBroadcast,
            TransferStatus::WaitingConfirmations,
            TransferStatus::Settled,
        ] {
            let mut altered = transfer.clone();
            altered.status = status;
            assert!(!admitted(&altered, &invoice));
        }
        for kind in [
            TransferKind::Send,
            TransferKind::Burn,
            TransferKind::Mint,
            TransferKind::Issuance,
            TransferKind::Link,
            TransferKind::Inflation,
        ] {
            let mut altered = transfer.clone();
            altered.kind = kind;
            assert!(!admitted(&altered, &invoice));
        }
        let mut altered = transfer.clone();
        altered.txid = Some("00".repeat(32));
        assert!(!admitted(&altered, &invoice));
        altered = transfer.clone();
        altered.consignment_path = Some("received".into());
        assert!(!admitted(&altered, &invoice));
        altered = transfer.clone();
        altered.sender_transport_endpoint = Some("https://proxy.invalid".into());
        assert!(!admitted(&altered, &invoice));
        altered = transfer.clone();
        altered.psbt_path = Some("prepared".into());
        assert!(!admitted(&altered, &invoice));
        altered = transfer.clone();
        altered.created_at = -1;
        assert!(!admitted(&altered, &invoice));
        altered.created_at = 201;
        assert!(!admitted(&altered, &invoice));
    }

    #[test]
    fn eligibility_does_not_trust_missing_or_malformed_invoice_text() {
        let (mut transfer, _) = ordinary();
        assert!(!eligible(&transfer, BitcoinNetwork::Regtest));
        transfer.invoice_string = Some("rgb:invalid".into());
        assert!(!eligible(&transfer, BitcoinNetwork::Regtest));
    }

    #[test]
    fn eligibility_parses_the_real_invoice_and_enforces_its_network() {
        use rgbinvoice::{Beneficiary, RgbInvoiceBuilder, XChainNet};
        let recipient = "bcrt:utxob:tjVmHbI2-U0_umHn-bU4cmP6-l3VW00H-ewoi2uz-XZG6O3i-wUFBW";
        let raw = RgbInvoiceBuilder::new(recipient.parse::<XChainNet<Beneficiary>>().unwrap())
            .set_contract(
                "rgb:seHWHNYA-~Fy85Df-sLB28o5-EcqC9F8-HW3mUaM-b7kRJgM"
                    .parse()
                    .unwrap(),
            )
            .set_schema(AssetSchema::Nia.into())
            .set_expiry_timestamp(200)
            .set_public_key([1; 32])
            .add_transport("rpc://127.0.0.1:3000/json-rpc")
            .unwrap()
            .finish()
            .to_string();
        let (mut transfer, _) = ordinary();
        transfer.recipient_id = Some(recipient.into());
        transfer.invoice_string = Some(raw);
        assert!(eligible(&transfer, BitcoinNetwork::Regtest));
        assert!(!eligible(&transfer, BitcoinNetwork::Signet));
        transfer.status = TransferStatus::Failed;
        assert!(!eligible(&transfer, BitcoinNetwork::Regtest));
    }
}
