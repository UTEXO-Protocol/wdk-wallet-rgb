// SPDX-License-Identifier: Apache-2.0
use super::{
    AssetFilter, Deserialize, Kind, Result, RgbWalletOpsOffline, RgbWalletOpsOnline, Serialize,
    Session, TransactionId, TransferStatus, Value, decode, fault, input, json, native,
    require_txid,
};
use rgb_lib::{
    WalletTransactionType,
    wallet::{TransferKind, TransferScope},
};
use std::collections::BTreeSet;

const MAX_RESERVATIONS: usize = 128;

#[derive(Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reservation {
    txid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch_transfer_idx: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Discard {
    kind: Kind,
    checkpoint: Vec<Reservation>,
    expected: Option<Reservation>,
}

fn unresolved() -> super::Fault {
    fault(
        "DISCARD_UNCERTAIN",
        "The exact unsigned reservation could not be identified or released safely.",
    )
}

fn check_reservation(row: &Reservation, kind: Kind) -> Result<()> {
    require_txid(&row.txid)?;
    match (kind, row.batch_transfer_idx) {
        (Kind::Btc | Kind::Outputs, None) => Ok(()),
        (Kind::Rgb | Kind::Burn, Some(idx)) if idx > 0 => Ok(()),
        _ => Err(input("Invalid unsigned reservation identity.")),
    }
}

fn added_reservation<'a>(
    before: &BTreeSet<Reservation>,
    current: &'a BTreeSet<Reservation>,
    expected: Option<&Reservation>,
) -> Result<Option<&'a Reservation>> {
    if expected.is_some_and(|row| before.contains(row)) {
        return Err(unresolved());
    }
    let mut added = current.iter().filter(|row| !before.contains(*row));
    let Some(row) = added.next() else {
        return Ok(None);
    };
    if added.next().is_some()
        || expected.is_some_and(|expected| expected != row)
        || before.iter().any(|known| {
            known.txid == row.txid
                || (known.batch_transfer_idx.is_some()
                    && known.batch_transfer_idx == row.batch_transfer_idx)
        })
    {
        return Err(unresolved());
    }
    Ok(Some(row))
}

impl Session {
    fn unsigned_reservations(&self, kind: Kind) -> Result<BTreeSet<Reservation>> {
        if self.journal_mode == super::journal::Mode::BtcOnly && kind != Kind::Btc {
            return Err(super::btc_only());
        }
        if self.transport_endpoint.is_some() && kind == Kind::Burn {
            return Err(super::bridge_unavailable());
        }
        let rows: BTreeSet<_> = match kind {
            Kind::Btc | Kind::Outputs => {
                let expected = if kind == Kind::Btc {
                    WalletTransactionType::SendBtc
                } else {
                    WalletTransactionType::CreateUtxos
                };
                self.wallet
                    .list_pending_vanilla_txs()
                    .map_err(native)?
                    .into_iter()
                    .filter(|row| row.r#type == expected)
                    .map(|row| Reservation {
                        txid: row.txid,
                        batch_transfer_idx: None,
                    })
                    .collect()
            }
            Kind::Rgb | Kind::Burn => {
                let expected = if kind == Kind::Rgb {
                    TransferKind::Send
                } else {
                    TransferKind::Burn
                };
                self.wallet
                    .list_transfers(AssetFilter::AnyOrNone, TransferScope::All)
                    .map_err(native)?
                    .into_iter()
                    .filter(|row| row.kind == expected && row.status == TransferStatus::Initiated)
                    .map(|row| {
                        Ok(Reservation {
                            txid: row.txid.ok_or_else(unresolved)?,
                            batch_transfer_idx: Some(row.batch_transfer_idx),
                        })
                    })
                    .collect::<Result<_>>()?
            }
        };
        if rows.len() > MAX_RESERVATIONS {
            return Err(unresolved());
        }
        for row in &rows {
            check_reservation(row, kind).map_err(|_| unresolved())?;
        }
        Ok(rows)
    }

    pub(super) fn snapshot_unsigned(&self, params: Value) -> Result<Value> {
        let p: Snapshot = decode(params)?;
        self.idle()?;
        Ok(json!({"reservations": self.unsigned_reservations(p.kind)?}))
    }

    pub(super) fn discard_unsubmitted(&mut self, params: Value) -> Result<Value> {
        let p: Discard = decode(params)?;
        if p.checkpoint.len() > MAX_RESERVATIONS {
            return Err(input("Unsigned reservation checkpoint exceeds its limit."));
        }
        for row in p.checkpoint.iter().chain(p.expected.iter()) {
            check_reservation(row, p.kind)?;
        }
        let len = p.checkpoint.len();
        let before: BTreeSet<_> = p.checkpoint.into_iter().collect();
        if before.len() != len {
            return Err(input(
                "Unsigned reservation checkpoint contains duplicates.",
            ));
        }
        // The trusted journal can request this only before an End call was possible. The
        // worker owns the wallet directory throughout the observation and cancellation.
        // Begin commits the wallet/transfer row and its inputs' reservations in one DB
        // transaction. Orphan unsigned RGB prep files do not reserve coins or authorize End.
        let current = self.unsigned_reservations(p.kind)?;
        if let Some(row) = added_reservation(&before, &current, p.expected.as_ref())? {
            if let Some(prepared) = &self.prepared {
                if prepared.kind != p.kind
                    || prepared.txid != row.txid
                    || prepared.batch_idx != row.batch_transfer_idx
                {
                    return Err(unresolved());
                }
                self.discard_prepared(TransactionId {
                    txid: row.txid.clone(),
                })?;
            } else if let Some(idx) = row.batch_transfer_idx {
                if !self
                    .wallet
                    .fail_transfers(self.online()?, Some(idx), false, false)
                    .map_err(native)?
                {
                    return Err(unresolved());
                }
            } else {
                self.wallet
                    .abort_pending_vanilla_tx(row.txid.clone())
                    .map_err(native)?;
            }
            let after = self.unsigned_reservations(p.kind)?;
            if added_reservation(&before, &after, p.expected.as_ref())?.is_some() {
                return Err(unresolved());
            }
        } else {
            // A retry after native cancellation and before the JS journal update reaches
            // this branch too. Only report success if the live worker has no prepared plan.
            self.idle()?;
        }
        Ok(json!({"discarded": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(txid: &str, batch: i32) -> Reservation {
        Reservation {
            txid: txid.repeat(32),
            batch_transfer_idx: Some(batch),
        }
    }

    #[test]
    fn attributes_only_a_unique_new_unsigned_reservation() {
        let before = BTreeSet::from([rgb("aa", 1)]);
        let current = BTreeSet::from([rgb("aa", 1), rgb("bb", 2)]);
        let expected = rgb("bb", 2);
        assert_eq!(
            added_reservation(&before, &current, None).unwrap(),
            Some(&expected)
        );
        assert_eq!(
            added_reservation(&before, &current, Some(&expected)).unwrap(),
            Some(&expected)
        );
        assert_eq!(
            added_reservation(&before, &before, Some(&expected)).unwrap(),
            None
        );
        assert!(added_reservation(&before, &current, Some(&rgb("aa", 1))).is_err());
        assert!(added_reservation(&before, &current, Some(&rgb("cc", 3))).is_err());
        for ambiguous in [
            BTreeSet::from([rgb("bb", 2), rgb("cc", 3)]),
            BTreeSet::from([rgb("aa", 2)]),
            BTreeSet::from([rgb("bb", 1)]),
        ] {
            assert!(added_reservation(&before, &ambiguous, None).is_err());
        }
    }
}
