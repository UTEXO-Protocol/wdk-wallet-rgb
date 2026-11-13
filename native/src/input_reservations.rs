// SPDX-License-Identifier: Apache-2.0
//! Preserve seals of a transaction whose signatures may have left this wallet.
//!
//! Upstream may mark an RGB send failed after a proxy deadline even when a recipient
//! previously obtained the signed transaction. Its inputs must not be reused for another
//! wallet transaction or a new RGB allocation. Records are retained independently of RGB's
//! transfer status. Confirmed spends naturally disappear from the set of available UTXOs.
use super::journal::{Scope, commit, corrupt, read_record};
use super::{Kind, Prepared, Result, Session, fault, json, lower_hex, storage, tx_id};
use rgb_lib::TransferStatus;
use rgb_lib::bitcoin::{OutPoint, Psbt};
use rgb_lib::no_wallet::RgbInspection;
use rgb_lib::wallet::{
    AssetFilter, RgbWalletOpsOffline, Transfer, TransferKind, TransferScope, Unspent,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::str::FromStr;

const MAX_INPUTS: usize = 384;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Exposure {
    txid: String,
    kind: String,
    inputs: Vec<String>,
}

fn reserved() -> super::Fault {
    fault(
        "SIGNED_INPUTS_RESERVED",
        "A prior RGB transaction may still spend these outputs. Its inputs cannot be reused.",
    )
}

fn psbt_inputs(psbt: &Psbt) -> Result<Vec<String>> {
    let inputs = psbt
        .unsigned_tx
        .input
        .iter()
        .map(|input| input.previous_output.to_string())
        .collect::<Vec<_>>();
    validate_inputs(&inputs)?;
    Ok(inputs)
}

fn validate_inputs(inputs: &[String]) -> Result<()> {
    if inputs.is_empty() || inputs.len() > MAX_INPUTS {
        return Err(corrupt());
    }
    let mut distinct = BTreeSet::new();
    for input in inputs {
        let outpoint = OutPoint::from_str(input).map_err(|_| corrupt())?;
        if outpoint.is_null() || outpoint.to_string() != *input || !distinct.insert(input) {
            return Err(corrupt());
        }
    }
    Ok(())
}

fn read_exposures(dir: &Path) -> Result<Vec<Exposure>> {
    let mut exposures = Vec::new();
    for entry in fs::read_dir(dir).map_err(storage)? {
        let path = entry.map_err(storage)?.path();
        if path.file_name().is_some_and(|name| name == "identity.json") {
            continue;
        }
        // A crash before rename can leave an uncommitted NamedTempFile. It never authorizes
        // an End call, which follows the durable rename and directory fsync.
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let txid = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(corrupt)?;
        if !lower_hex(txid, 64) {
            return Err(corrupt());
        }
        let record: Exposure = read_record(&path)?.ok_or_else(corrupt)?;
        if record.txid != txid || !matches!(record.kind.as_str(), "rgb-send" | "rgb-burn") {
            return Err(corrupt());
        }
        validate_inputs(&record.inputs)?;
        exposures.push(record);
    }
    Ok(exposures)
}

fn require_no_intersection(inputs: &[String], exposures: &[Exposure]) -> Result<()> {
    let candidates = inputs.iter().collect::<BTreeSet<_>>();
    if exposures
        .iter()
        .any(|record| record.inputs.iter().any(|input| candidates.contains(input)))
    {
        return Err(reserved());
    }
    Ok(())
}

fn owned_output_seals(
    inspection: &RgbInspection,
    mut concealed: impl FnMut(&str) -> Result<String>,
) -> Result<Vec<String>> {
    let invalid = || {
        fault(
            "INVALID_PREPARED_PLAN",
            "The wallet-owned RGB change seal could not be verified.",
        )
    };
    let mut seals = BTreeSet::new();
    for output in inspection
        .operations
        .iter()
        .flat_map(|operation| &operation.transitions)
        .flat_map(|transition| &transition.outputs)
    {
        match output.is_ours {
            Some(false) => continue,
            Some(true) => {}
            None => return Err(invalid()),
        }
        let outpoint = if output.is_concealed {
            if output.txid.is_some() || output.vout.is_some() {
                return Err(invalid());
            }
            concealed(output.recipient_id.as_deref().ok_or_else(invalid)?)?
        } else {
            let txid = output.txid.as_ref().ok_or_else(invalid)?;
            let vout = output.vout.ok_or_else(invalid)?;
            format!("{txid}:{vout}")
        };
        let parsed = OutPoint::from_str(&outpoint).map_err(|_| invalid())?;
        if parsed.is_null() || parsed.to_string() != outpoint {
            return Err(invalid());
        }
        seals.insert(outpoint);
    }
    Ok(seals.into_iter().collect())
}

fn native_reserves_inputs(exposure: &Exposure, transfers: &[Transfer]) -> bool {
    let expected = match exposure.kind.as_str() {
        "rgb-send" => TransferKind::Send,
        "rgb-burn" => TransferKind::Burn,
        _ => return false,
    };
    // Self-receives can share the witness TXID. Only the exact outgoing batch
    // owns its input reservations; incoming rows neither grant nor revoke them.
    let outgoing = transfers
        .iter()
        .filter(|row| matches!(row.kind, TransferKind::Send | TransferKind::Burn))
        .collect::<Vec<_>>();
    let Some(first) = outgoing.first() else {
        return false;
    };
    first.batch_transfer_idx > 0
        && outgoing.iter().any(|row| row.kind == expected)
        && outgoing.iter().all(|row| {
            row.txid.as_deref() == Some(exposure.txid.as_str())
                && row.batch_transfer_idx == first.batch_transfer_idx
                && row.status == first.status
                && matches!(
                    row.status,
                    TransferStatus::Initiated | TransferStatus::WaitingCounterparty
                )
        })
}

fn allocation_inputs(unspents: &[Unspent]) -> Vec<String> {
    unspents
        .iter()
        .filter(|unspent| {
            unspent.utxo.colorable
                && unspent.utxo.exists
                && unspent.rgb_allocations.is_empty()
                && unspent.pending_blinded == 0
        })
        .map(|unspent| {
            format!(
                "{}:{}",
                unspent.utxo.outpoint.txid, unspent.utxo.outpoint.vout
            )
        })
        .collect()
}

impl Session {
    fn exposed_inputs(&self) -> Result<Vec<Exposure>> {
        self.existing_journal_scope(Scope::ExposedInputs)?
            .map(|dir| read_exposures(&dir))
            .transpose()
            .map(Option::unwrap_or_default)
    }

    pub(super) fn require_unexposed_psbt(&self, psbt: &Psbt) -> Result<()> {
        require_no_intersection(&psbt_inputs(psbt)?, &self.exposed_inputs()?)
    }

    /// RGB change may be placed on an existing UTXO outside this PSBT's inputs.
    /// Check those destinations as well, before signatures can leave the wallet.
    pub(super) fn require_unexposed_rgb_outputs(&self, inspection: &RgbInspection) -> Result<()> {
        let exposures = self.exposed_inputs()?;
        if exposures.is_empty() {
            return Ok(());
        }
        let mut transfers = None;
        let seals = owned_output_seals(inspection, |recipient| {
            // A self-send to one of our blinded invoices remains concealed in the
            // inspection. Its public receive row identifies the actual owned seal.
            if transfers.is_none() {
                transfers = Some(
                    self.wallet
                        .list_transfers(AssetFilter::AnyOrNone, TransferScope::All)
                        .map_err(super::native)?,
                );
            }
            let matching = transfers
                .as_ref()
                .expect("loaded above")
                .iter()
                .filter(|row| {
                    row.kind == TransferKind::ReceiveBlind
                        && row.recipient_id.as_deref() == Some(recipient)
                })
                .filter_map(|row| row.receive_utxo.as_ref())
                .map(|outpoint| format!("{}:{}", outpoint.txid, outpoint.vout))
                .collect::<BTreeSet<_>>();
            if matching.len() != 1 {
                return Err(fault(
                    "INVALID_PREPARED_PLAN",
                    "The wallet-owned blinded RGB output could not be verified.",
                ));
            }
            Ok(matching.into_iter().next().expect("one matching seal"))
        })?;
        require_no_intersection(&seals, &exposures)
    }

    /// Called after signature/plan admission, before any RGB End call can expose it.
    /// A storage error leaves the prepared authority intact and broadcasts nothing.
    pub(super) fn reserve_exposed_inputs(&self, pending: &Prepared) -> Result<()> {
        let kind = match pending.kind {
            Kind::Rgb => "rgb-send",
            Kind::Burn => "rgb-burn",
            Kind::Btc | Kind::Outputs => return Ok(()),
        };
        let record = Exposure {
            txid: tx_id(&pending.psbt),
            kind: kind.into(),
            inputs: psbt_inputs(&pending.psbt)?,
        };
        if record.txid != pending.txid {
            return Err(corrupt());
        }
        let dir = self.bind_journal_scope(Scope::ExposedInputs)?;
        let mut previous = read_exposures(&dir)?;
        if let Some(index) = previous.iter().position(|other| other.txid == record.txid) {
            if previous.remove(index) != record {
                return Err(corrupt());
            }
            // A prior attempt may have failed after directory fsync. The same live prepared
            // authority can finish persistence, but a new Begin cannot reuse these inputs.
            require_no_intersection(&record.inputs, &previous)?;
            fs::File::open(&dir)
                .and_then(|file| file.sync_all())
                .map_err(storage)?;
            return Ok(());
        }
        require_no_intersection(&record.inputs, &previous)?;
        commit(
            &dir,
            dir.join(format!("{}.json", record.txid)),
            &json!(record),
            true,
        )
    }

    /// rgb-lib selects issuance/blind-receive seals internally. It excludes the
    /// inputs reserved by active outgoing batches, even empty fee inputs that the
    /// public Unspent representation shows as unallocated. BFA.8 creates those
    /// reservations in save_transfers for Initiated/WaitingCounterparty, removes
    /// them together with marking broadcast inputs spent, or together with Failed.
    /// Only those exact active batches may be excluded from this allocation check.
    /// Failed, absent or ambiguous transfers retain the independent exposure guard.
    pub(super) fn require_unexposed_allocations(&self, unspents: &[Unspent]) -> Result<()> {
        let mut unreserved = Vec::new();
        for exposure in self.exposed_inputs()? {
            let rows = self
                .wallet
                .list_transfers(
                    AssetFilter::AnyOrNone,
                    TransferScope::Txid(exposure.txid.clone()),
                )
                .map_err(super::native)?;
            if !native_reserves_inputs(&exposure, &rows) {
                unreserved.push(exposure);
            }
        }
        require_no_intersection(&allocation_inputs(unspents), &unreserved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Worker;
    use rgb_lib::BitcoinNetwork;
    use rgb_lib::bitcoin::absolute::LockTime;
    use rgb_lib::bitcoin::transaction::Version;
    use rgb_lib::bitcoin::{ScriptBuf, Sequence, Transaction, TxIn, Witness};
    use rgb_lib::keys::WitnessVersion;
    use std::os::unix::fs::PermissionsExt;

    fn plan(input: &str, kind: Kind) -> Prepared {
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: input.parse().unwrap(),
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::default(),
            }],
            output: vec![],
        };
        let psbt = Psbt::from_unsigned_tx(tx).unwrap();
        Prepared {
            kind,
            txid: tx_id(&psbt),
            psbt,
            batch_idx: Some(1),
            discard_requested: false,
        }
    }

    fn inspected_output(output: rgb_lib::no_wallet::RgbOutputInfo) -> RgbInspection {
        use rgb_lib::no_wallet::{RgbOperationInfo, RgbTransitionInfo};
        RgbInspection {
            txid: "03".repeat(32),
            close_method: rgb_lib::CloseMethod::OpretFirst,
            commitment_hex: "04".repeat(32),
            operations: vec![RgbOperationInfo {
                asset_id: "asset".into(),
                committed_transition_count: 1,
                committed_input_count: 1,
                transitions: vec![RgbTransitionInfo {
                    r#type: rgb_lib::TypeOfTransition::Transfer,
                    opid: "operation".into(),
                    inputs: vec![],
                    outputs: vec![output],
                    globals: vec![],
                    metadata: vec![],
                }],
            }],
        }
    }

    fn change(txid: &str) -> rgb_lib::no_wallet::RgbOutputInfo {
        rgb_lib::no_wallet::RgbOutputInfo {
            txid: Some(txid.into()),
            vout: Some(0),
            blinding: Some(1),
            assignment: rgb_lib::Assignment::Fungible(1),
            is_concealed: false,
            recipient_id: None,
            is_ours: Some(true),
            is_terminal: None,
        }
    }

    #[test]
    fn exposed_inputs_persist_after_restart_and_cannot_be_reused_by_another_plan() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let keys = rgb_lib::keys::generate_keys(BitcoinNetwork::Regtest, WitnessVersion::Taproot);
        let params = json!({"network":"regtest", "dataDir":dir.path(),
            "accountXpubVanilla": keys.account_xpub_vanilla,
            "accountXpubColored": keys.account_xpub_colored,
            "masterFingerprint":keys.master_fingerprint});
        let mut worker = Worker::default();
        worker.dispatch("open", params.clone()).unwrap();
        let original = plan(&format!("{}:0", "01".repeat(32)), Kind::Rgb);
        let other = plan(&format!("{}:0", "02".repeat(32)), Kind::Rgb);
        let session = worker.session.as_ref().unwrap();
        session.require_unexposed_psbt(&original.psbt).unwrap();
        session.reserve_exposed_inputs(&original).unwrap();
        session.reserve_exposed_inputs(&original).unwrap();
        assert_eq!(
            session
                .require_unexposed_psbt(&original.psbt)
                .unwrap_err()
                .code,
            "SIGNED_INPUTS_RESERVED"
        );
        session.require_unexposed_psbt(&other.psbt).unwrap();
        // The new Bitcoin transaction does not spend the exposed input, but an
        // RGB change allocation must not be placed on that older existing seal.
        let dangerous_change = inspected_output(change(&"01".repeat(32)));
        let fresh_change = inspected_output(change(&other.txid));
        assert_eq!(
            session
                .require_unexposed_rgb_outputs(&dangerous_change)
                .unwrap_err()
                .code,
            "SIGNED_INPUTS_RESERVED"
        );
        session
            .require_unexposed_rgb_outputs(&fresh_change)
            .unwrap();
        worker.dispatch("close", json!({})).unwrap();
        worker.dispatch("open", params).unwrap();
        let session = worker.session.as_ref().unwrap();
        assert_eq!(
            session
                .require_unexposed_psbt(&original.psbt)
                .unwrap_err()
                .code,
            "SIGNED_INPUTS_RESERVED"
        );
        session.require_unexposed_psbt(&other.psbt).unwrap();
        assert_eq!(
            session
                .require_unexposed_rgb_outputs(&dangerous_change)
                .unwrap_err()
                .code,
            "SIGNED_INPUTS_RESERVED"
        );
        session
            .require_unexposed_rgb_outputs(&fresh_change)
            .unwrap();
        let records = session.exposed_inputs().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].txid, original.txid);
        let path = dir
            .path()
            .join(".wdk-onchain-exposed-inputs-v1")
            .join(format!("{}.json", original.txid));
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        fs::write(&path, b"{}").unwrap();
        assert_eq!(
            session
                .require_unexposed_psbt(&other.psbt)
                .unwrap_err()
                .code,
            "JOURNAL_CORRUPT"
        );
    }

    #[test]
    fn concealed_self_send_resolves_its_owned_seal_but_external_seals_stay_private() {
        let mut own = change(&"ab".repeat(32));
        own.txid = None;
        own.vout = None;
        own.blinding = None;
        own.is_concealed = true;
        own.recipient_id = Some("our-blinded-invoice".into());
        let outpoint = format!("{}:0", "ab".repeat(32));
        let own_plan = inspected_output(own.clone());
        let outputs = owned_output_seals(&own_plan, |recipient| {
            assert_eq!(recipient, "our-blinded-invoice");
            Ok(outpoint.clone())
        })
        .unwrap();
        assert_eq!(outputs, [outpoint.clone()]);
        assert!(
            require_no_intersection(
                &outputs,
                &[Exposure {
                    txid: "cd".repeat(32),
                    kind: "rgb-send".into(),
                    inputs: vec![outpoint],
                }]
            )
            .is_err()
        );
        assert!(owned_output_seals(&own_plan, |_| Err(corrupt())).is_err());
        own.is_ours = Some(false);
        let external = owned_output_seals(&inspected_output(own), |_| {
            panic!("external seals must not be resolved")
        })
        .unwrap();
        assert!(external.is_empty());
    }

    #[test]
    fn unidentified_owned_rgb_change_cannot_bypass_exposure_admission() {
        let valid = change(&"ab".repeat(32));
        for field in 0..4 {
            let mut changed = valid.clone();
            match field {
                0 => changed.is_ours = None,
                1 => changed.txid = None,
                2 => changed.vout = None,
                3 => changed.txid = Some("invalid".into()),
                _ => unreachable!(),
            }
            assert!(
                owned_output_seals(&inspected_output(changed), |_| panic!("not concealed"))
                    .is_err()
            );
        }
        let empty = RgbInspection {
            operations: vec![],
            ..inspected_output(valid)
        };
        assert!(
            owned_output_seals(&empty, |_| panic!("no outputs"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn duplicate_noncanonical_and_null_inputs_are_rejected() {
        let valid = format!("{}:0", "ab".repeat(32));
        validate_inputs(std::slice::from_ref(&valid)).unwrap();
        for inputs in [
            vec![],
            vec![valid.clone(), valid.clone()],
            vec!["invalid".into()],
            vec![valid.to_uppercase()],
            vec![format!("{}:4294967295", "00".repeat(32))],
        ] {
            assert!(validate_inputs(&inputs).is_err());
        }
    }

    fn outgoing(txid: &str, status: TransferStatus) -> Transfer {
        Transfer {
            idx: 1,
            batch_transfer_idx: 2,
            created_at: 100,
            updated_at: 100,
            status,
            requested_assignment: None,
            assignments: vec![],
            kind: TransferKind::Send,
            txid: Some(txid.into()),
            recipient_id: None,
            receive_utxo: None,
            change_utxos: vec![],
            expiration_timestamp: Some(200),
            transport_endpoints: vec![],
            sender_transport_endpoint: None,
            invoice_string: None,
            consignment_path: None,
            psbt_path: None,
        }
    }

    #[test]
    fn pending_native_reservations_do_not_block_other_allocation_slots() {
        let exposure = Exposure {
            txid: "ab".repeat(32),
            kind: "rgb-send".into(),
            inputs: vec![format!("{}:0", "cd".repeat(32))],
        };
        for status in [
            TransferStatus::Initiated,
            TransferStatus::WaitingCounterparty,
        ] {
            let row = outgoing(&exposure.txid, status);
            assert!(native_reserves_inputs(
                &exposure,
                std::slice::from_ref(&row)
            ));
            let mut self_receive = row.clone();
            self_receive.kind = TransferKind::ReceiveBlind;
            self_receive.batch_transfer_idx = 3;
            self_receive.status = TransferStatus::WaitingBroadcast;
            assert!(native_reserves_inputs(&exposure, &[row, self_receive]));
        }
        let mut burn_exposure = Exposure {
            kind: "rgb-burn".into(),
            ..exposure
        };
        let mut burn = outgoing(&burn_exposure.txid, TransferStatus::Initiated);
        assert!(!native_reserves_inputs(
            &burn_exposure,
            std::slice::from_ref(&burn)
        ));
        burn.kind = TransferKind::Burn;
        assert!(native_reserves_inputs(
            &burn_exposure,
            std::slice::from_ref(&burn)
        ));
        burn_exposure.kind = "rgb-send".into();
        assert!(!native_reserves_inputs(&burn_exposure, &[burn]));
    }

    #[test]
    fn released_missing_or_ambiguous_batches_keep_allocation_exposure_protection() {
        let exposure = Exposure {
            txid: "ab".repeat(32),
            kind: "rgb-send".into(),
            inputs: vec![format!("{}:0", "cd".repeat(32))],
        };
        assert!(!native_reserves_inputs(&exposure, &[]));
        for status in [
            TransferStatus::Failed,
            TransferStatus::WaitingConfirmations,
            TransferStatus::Settled,
            TransferStatus::WaitingBroadcast,
        ] {
            assert!(!native_reserves_inputs(
                &exposure,
                &[outgoing(&exposure.txid, status)]
            ));
        }
        let row = outgoing(&exposure.txid, TransferStatus::WaitingCounterparty);
        let mut other = row.clone();
        other.batch_transfer_idx = 3;
        assert!(!native_reserves_inputs(&exposure, &[row.clone(), other]));
        other = row.clone();
        other.txid = Some("ee".repeat(32));
        assert!(!native_reserves_inputs(&exposure, &[other]));
        other = row.clone();
        other.status = TransferStatus::Failed;
        assert!(!native_reserves_inputs(&exposure, &[row, other]));
    }

    #[test]
    fn ordinary_allocations_ignore_spent_and_already_allocated_outputs() {
        use rgb_lib::Assignment;
        use rgb_lib::wallet::{Outpoint, RgbAllocation, Utxo};
        let txid = "ab".repeat(32);
        let base = Unspent {
            utxo: Utxo {
                outpoint: Outpoint {
                    txid: txid.clone(),
                    vout: 0,
                },
                btc_amount: 1000,
                colorable: true,
                exists: true,
                derivation_index: Some(0),
            },
            rgb_allocations: vec![],
            pending_blinded: 0,
        };
        let exposures = vec![Exposure {
            txid: "cd".repeat(32),
            kind: "rgb-send".into(),
            inputs: vec![format!("{txid}:0")],
        }];
        let available = |value: &Unspent| allocation_inputs(std::slice::from_ref(value));
        assert!(require_no_intersection(&available(&base), &exposures).is_err());
        let mut occupied = base.clone();
        occupied.pending_blinded = 1;
        require_no_intersection(&available(&occupied), &exposures).unwrap();
        occupied = base.clone();
        occupied.utxo.exists = false;
        require_no_intersection(&available(&occupied), &exposures).unwrap();
        occupied = base.clone();
        occupied.rgb_allocations.push(RgbAllocation {
            asset_id: Some("asset".into()),
            assignment: Assignment::Fungible(1),
            settled: true,
        });
        require_no_intersection(&available(&occupied), &exposures).unwrap();
    }
}
