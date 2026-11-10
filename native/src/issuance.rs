// SPDX-License-Identifier: Apache-2.0
use super::journal::{Scope, commit, corrupt, read_record, valid_operation_id};
use super::{
    AssetFilter, AssetSchema, Assignment, Balance, BitcoinNetwork, Deserialize, Result, Serialize,
    Session, TransferScope, TransferStatus, Value, decode, fault, input, iso_balance, json, native,
    positive, require_asset, sha256,
};
use rgb_lib::wallet::{RgbWalletOpsOffline, Transfer, TransferKind};
use std::path::Path;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
enum Schema {
    Nia,
    Cfa,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation_id: String,
    schema: Schema,
    name: String,
    ticker: Option<String>,
    details: Option<String>,
    precision: u8,
    amounts: Vec<String>,
}

impl Request {
    fn validate(&self) -> Result<(Vec<u64>, u64)> {
        if !valid_operation_id(&self.operation_id)
            || !(1..=40).contains(&self.name.len())
            || !self.name.bytes().all(|b| (b' '..=b'~').contains(&b))
            || self.precision > 18
            || !(1..=20).contains(&self.amounts.len())
        {
            return Err(input("Invalid RGB issuance parameters."));
        }
        match (self.schema, self.ticker.as_deref(), self.details.as_deref()) {
            (Schema::Nia, Some(ticker), None)
                if (1..=8).contains(&ticker.len())
                    && ticker.as_bytes()[0].is_ascii_uppercase()
                    && ticker
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) => {}
            (Schema::Cfa, None, details)
                if details.is_none_or(|text| (1..=255).contains(&text.len())) => {}
            _ => return Err(input("Invalid ticker or details for the RGB asset schema.")),
        }
        let amounts = self
            .amounts
            .iter()
            .map(|value| positive(value, u64::MAX))
            .collect::<Result<Vec<_>>>()?;
        let supply = amounts
            .iter()
            .try_fold(0u64, |sum, amount| sum.checked_add(*amount))
            .ok_or_else(|| input("RGB issuance exceeds the maximum supply."))?;
        Ok((amounts, supply))
    }

    fn digest(&self) -> String {
        sha256(&serde_json::to_vec(self).expect("serializable issuance parameters"))
    }

    fn result(&self, asset_id: String, balance: Balance) -> Value {
        json!({
            "assetId": asset_id, "schema": self.schema, "name": self.name,
            "ticker": self.ticker, "precision": self.precision,
            "balance": iso_balance(balance),
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    request: Request,
    after: i32,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    request_digest: String,
    result: Option<Value>,
}

fn receipt_path(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.json"))
}

fn read_receipt(dir: &Path, request: &Request) -> Result<Option<Receipt>> {
    let receipt: Option<Receipt> = read_record(&receipt_path(dir, &request.operation_id))?;
    if receipt
        .as_ref()
        .is_some_and(|r| r.request_digest != request.digest())
    {
        return Err(input(
            "The issuance operation ID already belongs to different parameters.",
        ));
    }
    Ok(receipt)
}

fn save_receipt(dir: &Path, request: &Request, result: Option<Value>) -> Result<()> {
    let receipt = Receipt {
        request_digest: request.digest(),
        result,
    };
    commit(
        dir,
        receipt_path(dir, &request.operation_id),
        &json!(receipt),
        false,
    )
}

fn unresolved() -> super::Fault {
    fault(
        "ISSUANCE_UNRESOLVED",
        "The previous RGB issuance could not be safely reconciled.",
    )
}

impl Session {
    fn issuances(&self) -> Result<impl Iterator<Item = Transfer>> {
        Ok(self
            .wallet
            .list_transfers(AssetFilter::AnyOrNone, TransferScope::All)
            .map_err(native)?
            .into_iter()
            .filter(|transfer| transfer.kind == TransferKind::Issuance))
    }

    fn recover_issuance(
        &self,
        pending: &Pending,
        mut amounts: Vec<u64>,
        supply: u64,
    ) -> Result<Option<Value>> {
        let request = &pending.request;
        let mut issuances = self.issuances()?;
        // A prior checkpoint cannot disappear from a complete wallet directory.
        if pending.after < 0
            || (pending.after > 0
                && !issuances
                    .by_ref()
                    .any(|transfer| transfer.idx == pending.after))
        {
            return Err(unresolved());
        }
        let mut new = issuances.filter(|transfer| transfer.idx > pending.after);
        let Some(transfer) = new.next() else {
            return Ok(None);
        };
        if new.next().is_some() || transfer.status != TransferStatus::Settled {
            return Err(unresolved());
        }
        let Some(mut assignments) = transfer
            .assignments
            .into_iter()
            .map(|assignment| match assignment {
                Assignment::Fungible(amount) => Some(amount),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
        else {
            return Err(unresolved());
        };
        assignments.sort_unstable();
        amounts.sort_unstable();
        if assignments != amounts {
            return Err(unresolved());
        }
        // rgb-lib derives the filename from the committed issuance row's asset ID.
        // Never scan or trust a genesis file, which can exist before the DB commits.
        let asset_id = transfer
            .consignment_path
            .as_deref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|id| id.to_str())
            .ok_or_else(unresolved)?;
        self.check_issued_asset(request, asset_id, supply)?;
        let balance = self
            .wallet
            .get_asset_balance(asset_id.to_owned())
            .map_err(native)?;
        Ok(Some(request.result(asset_id.to_owned(), balance)))
    }

    fn check_issued_asset(&self, request: &Request, asset_id: &str, supply: u64) -> Result<()> {
        require_asset(asset_id).map_err(|_| unresolved())?;
        let meta = self
            .wallet
            .get_asset_metadata(asset_id.to_owned())
            .map_err(|error| match error {
                rgb_lib::Error::AssetNotFound { .. } => unresolved(),
                other => native(other),
            })?;
        let schema = match request.schema {
            Schema::Nia => AssetSchema::Nia,
            Schema::Cfa => AssetSchema::Cfa,
        };
        if meta.asset_schema != schema
            || meta.initial_supply != supply
            || meta.name != request.name
            || meta.ticker != request.ticker
            || meta.details != request.details
            || meta.precision != request.precision
        {
            return Err(unresolved());
        }
        Ok(())
    }

    fn completed_issuance(
        &self,
        dir: &Path,
        request: &Request,
        supply: u64,
    ) -> Result<Option<Value>> {
        let result = read_receipt(dir, request)?.and_then(|r| r.result);
        if let Some(result) = &result {
            let asset_id = result["assetId"].as_str().ok_or_else(corrupt)?;
            self.check_issued_asset(request, asset_id, supply)?;
        }
        Ok(result)
    }

    pub(super) fn issue_asset(&mut self, params: Value) -> Result<Value> {
        if self.network != BitcoinNetwork::Regtest {
            return Err(fault(
                "ASSET_ISSUANCE_UNAVAILABLE",
                "RGB test asset issuance requires Regtest.",
            ));
        }
        self.idle()?;
        let request: Request = decode(params)?;
        let (amounts, supply) = request.validate()?;
        let dir = self.bind_journal_scope(Scope::Issuance)?;
        if let Some(result) = self.completed_issuance(&dir, &request, supply)? {
            return Ok(result);
        }
        let pending_path = dir.join(".pending.json");
        if let Some(pending) = read_record::<Pending>(&pending_path)? {
            let previous = &pending.request;
            let (previous_amounts, previous_supply) = previous.validate().map_err(|_| corrupt())?;
            let same_id = request.operation_id == previous.operation_id;
            if same_id && request.digest() != previous.digest() {
                return Err(input(
                    "The issuance operation ID already belongs to different parameters.",
                ));
            }
            if self
                .completed_issuance(&dir, previous, previous_supply)?
                .is_none()
            {
                let recovered =
                    self.recover_issuance(&pending, previous_amounts, previous_supply)?;
                save_receipt(&dir, previous, recovered.clone())?;
                if same_id && let Some(result) = recovered {
                    return Ok(result);
                }
            }
        }

        let online = self.online()?;
        self.wallet
            .list_unspents(Some(online), false, false)
            .map_err(native)?;
        let after = self
            .issuances()?
            .map(|transfer| transfer.idx)
            .max()
            .unwrap_or(0);
        // One intent is durable before touching RGB state. A receipt is finalized before
        // any later issuance may advance the checkpoint, including after a process restart.
        commit(
            &dir,
            pending_path,
            &json!({"request": request, "after": after}),
            false,
        )?;
        let issued = match request.schema {
            Schema::Nia => self
                .wallet
                .issue_asset_nia(
                    request.ticker.clone().expect("validated NIA ticker"),
                    request.name.clone(),
                    request.precision,
                    amounts,
                )
                .map(|asset| (asset.asset_id, asset.balance)),
            Schema::Cfa => self
                .wallet
                .issue_asset_cfa(
                    request.name.clone(),
                    request.details.clone(),
                    request.precision,
                    amounts,
                    None,
                )
                .map(|asset| (asset.asset_id, asset.balance)),
        }
        .map_err(|error| match error {
            rgb_lib::Error::InsufficientAllocationSlots => fault(
                "INSUFFICIENT_RGB_OUTPUTS",
                "Create and confirm more RGB outputs before issuing this asset.",
            ),
            other => native(other),
        })?;
        let (asset_id, balance) = issued;
        let result = request.result(asset_id, balance);
        save_receipt(&dir, &request, Some(result.clone()))?;
        Ok(result)
    }
}
