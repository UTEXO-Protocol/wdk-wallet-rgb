// SPDX-License-Identifier: Apache-2.0
use super::{
    Empty, Refresh, Result, Session, TransactionId, Value, decode, fault, iso_balance, json,
    native, require_asset, require_txid,
};
use rgb_lib::wallet::{RgbWalletOpsOffline, RgbWalletOpsOnline};

impl Session {
    pub(super) fn assets(&self, params: Value) -> Result<Value> {
        let _: Empty = decode(params)?;
        let assets = self.wallet.list_assets(vec![]).map_err(native)?;
        let mut rows = Vec::new();
        // Only public display metadata crosses the boundary. The full RGB objects
        // may include attachment paths and other wallet-local state.
        macro_rules! add_assets {
            ($field:ident, $schema:literal, $ticker:expr) => {
                for row in assets.$field.into_iter().flatten() {
                    rows.push(json!({
                        "assetId": row.asset_id,
                        "schema": $schema,
                        "ticker": ($ticker)(&row),
                        "name": row.name,
                        "precision": row.precision,
                        "balance": iso_balance(row.balance),
                    }));
                }
            };
        }
        add_assets!(nia, "Nia", |r: &rgb_lib::wallet::AssetNIA| Some(
            r.ticker.clone()
        ));
        add_assets!(uda, "Uda", |r: &rgb_lib::wallet::AssetUDA| Some(
            r.ticker.clone()
        ));
        add_assets!(cfa, "Cfa", |_: &rgb_lib::wallet::AssetCFA| None::<String>);
        add_assets!(ifa, "Ifa", |r: &rgb_lib::wallet::AssetIFA| Some(
            r.ticker.clone()
        ));
        add_assets!(bfa, "Bfa", |r: &rgb_lib::wallet::AssetBFA| Some(
            r.ticker.clone()
        ));
        Ok(Value::Array(rows))
    }

    pub(super) fn cancel_abandoned_outputs(&mut self, params: Value) -> Result<Value> {
        let p: TransactionId = decode(params)?;
        require_txid(&p.txid)?;
        self.idle()?;
        let matching = self
            .wallet
            .list_pending_vanilla_txs()
            .map_err(native)?
            .into_iter()
            .filter(|row| {
                row.txid == p.txid && row.r#type == rgb_lib::WalletTransactionType::CreateUtxos
            })
            .count();
        if matching != 1 {
            return Err(fault(
                "DISCARD_UNCERTAIN",
                "The exact unsigned RGB output reservation was not found.",
            ));
        }
        self.wallet
            .abort_pending_vanilla_tx(p.txid)
            .map_err(native)?;
        Ok(json!({}))
    }

    pub(super) fn refresh_transfers(&mut self, params: Value) -> Result<Value> {
        let p: Refresh = decode(params)?;
        self.idle()?;
        if let Some(asset) = &p.asset_id {
            require_asset(asset)?;
        }
        let result = self
            .wallet
            .refresh(self.online()?, p.asset_id, vec![], false)
            .map_err(native)?;
        let mut transfers = result
            .into_iter()
            .map(|(idx, status)| {
                json!({
                    "batchTransferIdx": idx,
                    "status": status.updated_status,
                    "failure": status.failure.map(native),
                })
            })
            .collect::<Vec<_>>();
        transfers.sort_unstable_by_key(|row| row["batchTransferIdx"].as_i64().unwrap_or_default());
        Ok(json!({"transfers": transfers}))
    }
}
