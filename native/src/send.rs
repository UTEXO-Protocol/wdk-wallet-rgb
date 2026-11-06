// SPDX-License-Identifier: Apache-2.0
//! Send-only admission and exact status evidence for the watch-only engine.
use super::*;
use rgb_lib::bitcoin::ScriptBuf;
use rgb_lib::wallet::{Recipient, TransferKind, WitnessData};
use rgbinvoice::{Beneficiary, XChainNet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendBtc {
    address: String,
    amount: String,
    fee_rate: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendRgb {
    invoice: String,
    asset_id: String,
    recipient_id: String,
    amount: String,
    fee_rate: String,
    min_confirmations: u8,
    expiration_timestamp: String,
    sender_transport_endpoint: String,
    witness_amount_sat: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SendKind {
    BtcSend,
    RgbSend,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SendStatus {
    kind: SendKind,
    txid: String,
    asset_id: Option<String>,
    recipient_id: Option<String>,
    amount: Option<String>,
    batch_transfer_idx: Option<i32>,
}

enum RecipientSeal {
    Blind,
    Witness(ScriptBuf),
}

fn recipient_seal(recipient_id: &str) -> Result<RecipientSeal> {
    let beneficiary = XChainNet::<Beneficiary>::from_str(recipient_id)
        .map_err(|_| input("Invalid RGB invoice recipient."))?;
    Ok(match beneficiary.into_inner() {
        Beneficiary::BlindedSeal(_) => RecipientSeal::Blind,
        Beneficiary::WitnessVout(pay_to, _) => RecipientSeal::Witness(pay_to.to_script()),
    })
}

pub(super) fn decoded_invoice(raw: &str) -> Result<Value> {
    let inv = invoice(raw)?;
    let (recipient_type, witness_script) = match recipient_seal(&inv.recipient_id)? {
        RecipientSeal::Blind => ("Blind", None),
        RecipientSeal::Witness(script) => ("Witness", Some(script.to_hex_string())),
    };
    Ok(json!({
        "recipientId":inv.recipient_id,"assetId":inv.asset_id,"schema":inv.asset_schema,
        "network":format!("{:?}",inv.network).to_lowercase(),
        "assignment":assignment_value(&inv.assignment),"transportEndpoints":inv.transport_endpoints,
        "expirationTimestamp":inv.expiration_timestamp.map(|v| v.to_string()),
        "publicKey":inv.public_key,"encryption":inv.encryption,
        "recipientType":recipient_type,"witnessScriptHex":witness_script,
    }))
}

fn not_prepared(message: &'static str) -> Fault {
    fault("SEND_NOT_PREPARED", message)
}

fn safe_preparation_error(err: rgb_lib::Error) -> Fault {
    // These errors precede input reservation. I/O, consistency and unexpected
    // failures remain unresolved because they may occur while committing it.
    use rgb_lib::Error::*;
    match err {
        InsufficientBitcoins { .. } => not_prepared("There is not enough spendable Bitcoin."),
        InsufficientAssignments { .. } => not_prepared("There is not enough spendable RGB."),
        OutputBelowDustLimit => not_prepared("The payment output is below the Bitcoin dust limit."),
        InvoiceQuotaExceeded | InvoiceNotReserved | NoValidTransportEndpoint => {
            not_prepared("The RGB recipient invoice is unavailable.")
        }
        InvalidExpiration => not_prepared("The RGB invoice expires too soon to send safely."),
        _ => native(err),
    }
}

fn exact_witness_output(psbt: &Psbt, script: &ScriptBuf, sats: u64) -> Option<u32> {
    let mut matches = psbt
        .unsigned_tx
        .output
        .iter()
        .enumerate()
        .filter(|(_, output)| output.script_pubkey == *script && output.value.to_sat() == sats);
    let (index, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    u32::try_from(index).ok()
}

fn exact_rgb_send(
    inspection: &RgbInspection,
    txid: &str,
    asset_id: &str,
    amount: u64,
    recipient_id: &str,
    witness_vout: Option<u32>,
) -> bool {
    if inspection.txid != txid {
        return false;
    }
    let mut matched = false;
    for operation in &inspection.operations {
        if usize::try_from(operation.committed_transition_count).ok()
            != Some(operation.transitions.len())
        {
            return false;
        }
        for transition in &operation.transitions {
            if !matches!(
                transition.r#type,
                TypeOfTransition::Transfer
                    | TypeOfTransition::TransferInflation
                    | TypeOfTransition::TransferLink
                    | TypeOfTransition::Propagate
            ) || !transition.globals.is_empty()
            {
                return false;
            }
            for output in &transition.outputs {
                let matches_recipient = match witness_vout {
                    None => {
                        output.is_concealed && output.recipient_id.as_deref() == Some(recipient_id)
                    }
                    Some(vout) => {
                        !output.is_concealed
                            && output.txid.as_deref() == Some(txid)
                            && output.vout == Some(vout)
                    }
                };
                if matches_recipient
                    && operation.asset_id == asset_id
                    && transition.r#type == TypeOfTransition::Transfer
                    && output.assignment == Assignment::Fungible(amount)
                {
                    if matched {
                        return false;
                    }
                    matched = true;
                } else if matches_recipient || output.is_ours != Some(true) {
                    // A send may move other allocations into wallet-owned change.
                    // It must never allocate them to this or another recipient.
                    return false;
                }
            }
        }
    }
    matched
}

impl Session {
    pub(super) fn send_btc_begin(&mut self, p: SendBtc) -> Result<Value> {
        self.idle()?;
        let online = self.online()?;
        if p.address.len() > 128
            || BitcoinAddress::from_str(&p.address)
                .and_then(|a| a.require_network(bitcoin_chain(self.network)))
                .is_err()
        {
            return Err(not_prepared(
                "Bitcoin address is invalid for this wallet network.",
            ));
        }
        let amount = positive(&p.amount, MAX_MONEY).map_err(|err| not_prepared(err.message))?;
        let fee_rate =
            positive(&p.fee_rate, MAX_FEE_RATE).map_err(|err| not_prepared(err.message))?;
        let psbt = self
            .wallet
            .send_btc_begin(online, p.address, amount, fee_rate, false, false)
            .map_err(safe_preparation_error)?;
        self.prepare(Kind::Btc, psbt, None)
    }

    pub(super) fn send_rgb_begin(&mut self, p: SendRgb) -> Result<Value> {
        self.idle()?;
        let online = self.online()?;
        require_asset(&p.asset_id).map_err(|err| not_prepared(err.message))?;
        self.validate_wallet_proxy(&p.sender_transport_endpoint)
            .map_err(|err| not_prepared(err.message))?;
        let decoded = invoice(&p.invoice).map_err(|_| not_prepared("Invalid RGB invoice."))?;
        if decoded.network != self.network
            || decoded.recipient_id != p.recipient_id
            || decoded
                .asset_id
                .as_ref()
                .is_some_and(|id| id != &p.asset_id)
            || decoded.transport_endpoints.len() != 1
            || decoded.transport_endpoints[0] != p.sender_transport_endpoint
            || !decoded
                .public_key
                .as_ref()
                .is_some_and(|s| lower_hex(s, 64))
            || p.min_confirmations == 0
        {
            return Err(not_prepared(
                "Invoice network, asset, proxy, or recipient key is outside this wallet profile.",
            ));
        }
        let amount = positive(&p.amount, u64::MAX).map_err(|err| not_prepared(err.message))?;
        // Some schemas decode an amountless invoice as Fungible(0).
        if !matches!(
            decoded.assignment,
            Assignment::Any | Assignment::Fungible(0)
        ) && decoded.assignment != Assignment::Fungible(amount)
        {
            return Err(not_prepared(
                "Invoice does not permit the exact fungible amount.",
            ));
        }
        let seal =
            recipient_seal(&decoded.recipient_id).map_err(|err| not_prepared(err.message))?;
        let witness_data = match (&seal, p.witness_amount_sat) {
            (RecipientSeal::Blind, None) => None,
            (RecipientSeal::Witness(_), Some(sats)) => Some(WitnessData {
                amount_sat: positive(&sats, MAX_MONEY).map_err(|err| not_prepared(err.message))?,
                blinding: None,
            }),
            _ => {
                return Err(not_prepared(
                    "Explicit witness value is required only for a witness invoice.",
                ));
            }
        };
        let expiration = positive(&p.expiration_timestamp, i64::MAX as u64)
            .map_err(|err| not_prepared(err.message))?;
        if decoded
            .expiration_timestamp
            .is_none_or(|e| e < expiration.saturating_add(600))
        {
            return Err(not_prepared(
                "RGB operation expiry is too close to the invoice expiry.",
            ));
        }
        let fee_rate =
            positive(&p.fee_rate, MAX_FEE_RATE).map_err(|err| not_prepared(err.message))?;
        let witness_sats = witness_data.as_ref().map(|data| data.amount_sat);
        let recipient = Recipient {
            recipient_id: decoded.recipient_id,
            witness_data,
            assignment: Assignment::Fungible(amount),
            transport_endpoints: decoded.transport_endpoints,
            public_key: decoded.public_key,
            encryption: decoded.encryption,
            expiration_timestamp: decoded.expiration_timestamp,
        };
        let plan = self
            .wallet
            .send_begin(
                online,
                HashMap::from([(p.asset_id.clone(), vec![recipient])]),
                false,
                fee_rate,
                p.min_confirmations,
                expiration,
                Some(p.sender_transport_endpoint),
                false,
            )
            .map_err(safe_preparation_error)?;

        let result = self.prepare(Kind::Rgb, plan.psbt.clone(), plan.batch_transfer_idx)?;
        let prepared = self.prepared.as_ref().expect("just prepared");
        let txid = prepared.txid.clone();
        let witness_vout = match (&seal, witness_sats) {
            (RecipientSeal::Blind, None) => Some(None),
            (RecipientSeal::Witness(script), Some(sats)) => {
                exact_witness_output(&prepared.psbt, script, sats).map(Some)
            }
            _ => None,
        };
        let admitted = witness_vout.is_some_and(|vout| {
            self.wallet
                .inspect_rgb_transfer(plan.psbt, plan.details.fascia_path, plan.details.entropy)
                .is_ok_and(|inspection| {
                    exact_rgb_send(
                        &inspection,
                        &txid,
                        &p.asset_id,
                        amount,
                        &p.recipient_id,
                        vout,
                    )
                })
        });
        if admitted {
            return Ok(result);
        }
        // No signatures exist and End has not run. Only release this worker's
        // exact reservation. If cancellation is uncertain, leave it blocked.
        self.discard_prepared(TransactionId { txid }).map_err(|_| {
            fault(
                "SEND_PLAN_UNRESOLVED",
                "An invalid RGB send plan could not be released safely.",
            )
        })?;
        Err(fault(
            "SEND_PLAN_REJECTED",
            "The native plan did not commit to the exact requested RGB recipient and amount.",
        ))
    }

    pub(super) fn send_status(&mut self, p: SendStatus) -> Result<Value> {
        require_txid(&p.txid)?;
        match p.kind {
            SendKind::BtcSend => {
                if p.asset_id.is_some()
                    || p.recipient_id.is_some()
                    || p.amount.is_some()
                    || p.batch_transfer_idx.is_some()
                {
                    return Err(input(
                        "Bitcoin send evidence must contain only its transaction ID.",
                    ));
                }
                let online = self.online()?;
                let matches = self
                    .wallet
                    .list_transactions(Some(online), self.prepared.is_some())
                    .map_err(native)?
                    .into_iter()
                    .filter(|t| t.txid == p.txid && t.sent > 0)
                    .count();
                let state = if matches == 1 {
                    "submitted"
                } else {
                    "unresolved"
                };
                Ok(json!({"kind":"btc-send","txid":p.txid,"state":state}))
            }
            SendKind::RgbSend => {
                let asset = p
                    .asset_id
                    .ok_or_else(|| input("RGB send evidence needs an asset ID."))?;
                require_asset(&asset)?;
                let recipient = p
                    .recipient_id
                    .filter(|s| s.len() <= 256)
                    .ok_or_else(|| input("RGB send evidence needs a recipient."))?;
                recipient_seal(&recipient)?;
                let amount = positive(p.amount.as_deref().unwrap_or_default(), u64::MAX)?;
                let batch = p
                    .batch_transfer_idx
                    .filter(|n| *n > 0)
                    .ok_or_else(|| input("RGB send evidence needs a batch index."))?;
                let transfers = self
                    .wallet
                    .list_transfers(AssetFilter::Id(asset), TransferScope::Txid(p.txid.clone()))
                    .map_err(native)?;
                let mut matching = transfers.iter().filter(|t| {
                    t.kind == TransferKind::Send
                        && t.txid.as_deref() == Some(p.txid.as_str())
                        && t.batch_transfer_idx == batch
                        && t.recipient_id.as_deref() == Some(recipient.as_str())
                        && t.requested_assignment == Some(Assignment::Fungible(amount))
                });
                let state = match (matching.next().map(|t| t.status), matching.next()) {
                    (
                        Some(
                            TransferStatus::WaitingCounterparty
                            | TransferStatus::WaitingConfirmations
                            | TransferStatus::Settled,
                        ),
                        None,
                    ) => "submitted",
                    (Some(TransferStatus::Failed), None) => "failed",
                    _ => "unresolved",
                };
                Ok(json!({"kind":"rgb-send","txid":p.txid,"batchTransferIdx":batch,"state":state}))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::no_wallet::{RgbOperationInfo, RgbOutputInfo, RgbTransitionInfo};

    fn blind_output(recipient_id: &str, amount: u64, is_ours: bool) -> RgbOutputInfo {
        RgbOutputInfo {
            txid: None,
            vout: None,
            blinding: None,
            assignment: Assignment::Fungible(amount),
            is_concealed: true,
            recipient_id: Some(recipient_id.into()),
            is_ours: Some(is_ours),
            is_terminal: None,
        }
    }

    #[test]
    fn transfer_admission_requires_the_exact_recipient_and_no_other_external_assignment() {
        let mut inspected = RgbInspection {
            txid: "tx".into(),
            close_method: rgb_lib::CloseMethod::OpretFirst,
            commitment_hex: "commitment".into(),
            operations: vec![RgbOperationInfo {
                asset_id: "asset".into(),
                committed_transition_count: 1,
                committed_input_count: 1,
                transitions: vec![RgbTransitionInfo {
                    r#type: TypeOfTransition::Transfer,
                    opid: "op".into(),
                    inputs: vec![],
                    outputs: vec![
                        blind_output("receiver", 25, false),
                        blind_output("change", 75, true),
                    ],
                    globals: vec![],
                    metadata: vec![],
                }],
            }],
        };
        let admits = |plan: &RgbInspection, amount| {
            exact_rgb_send(plan, "tx", "asset", amount, "receiver", None)
        };
        assert!(admits(&inspected, 25));
        assert!(!admits(&inspected, 26));
        assert!(!exact_rgb_send(
            &inspected, "tx", "asset", 25, "other", None
        ));

        inspected.operations[0].transitions[0]
            .outputs
            .push(blind_output("other", 1, false));
        assert!(!admits(&inspected, 25));
        inspected.operations[0].transitions[0].outputs.pop();
        inspected.operations[0].transitions[0]
            .outputs
            .push(blind_output("receiver", 25, true));
        assert!(!admits(&inspected, 25));
        inspected.operations[0].transitions[0].outputs.pop();

        let witness = &mut inspected.operations[0].transitions[0].outputs[0];
        witness.txid = Some("tx".into());
        witness.vout = Some(2);
        witness.recipient_id = None;
        witness.is_concealed = false;
        assert!(exact_rgb_send(
            &inspected,
            "tx",
            "asset",
            25,
            "witness",
            Some(2)
        ));
        assert!(!exact_rgb_send(
            &inspected,
            "tx",
            "asset",
            25,
            "witness",
            Some(3)
        ));
        inspected.operations[0].committed_transition_count = 2;
        assert!(!exact_rgb_send(
            &inspected,
            "tx",
            "asset",
            25,
            "witness",
            Some(2)
        ));
    }
}
