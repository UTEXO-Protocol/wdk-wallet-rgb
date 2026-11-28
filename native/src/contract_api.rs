// SPDX-License-Identifier: Apache-2.0
//! Bounded public contract bytes, using upstream's offline import/export APIs.
use super::{
    Asset, Contract, MAX_CONTRACT, Result, Session, Value, fault, input, json, lower_hex, native,
    read_bounded, require_asset, sha256, storage,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rgb_lib::no_wallet::{BundleFilter, inspect_consignment};
use rgb_lib::wallet::RgbWalletOpsOffline;
use std::io::Write;
use std::path::Path;

fn invalid_contract() -> super::Fault {
    fault(
        "CONTRACT_INVALID",
        "The public RGB contract is invalid or unsupported.",
    )
}

fn import_error(error: rgb_lib::Error) -> super::Fault {
    use rgb_lib::Error;
    match error {
        Error::AssetAlreadyKnown { .. } => fault(
            "ASSET_ALREADY_KNOWN",
            "The RGB asset is already registered. Read its existing metadata.",
        ),
        Error::InvalidAttachments { .. } => fault(
            "CONTRACT_MEDIA_REQUIRED",
            "The contract requires media that is not available in this wallet.",
        ),
        Error::InvalidContract { .. }
        | Error::InvalidConsignment
        | Error::ConsignmentValidationFailed { .. }
        | Error::UnknownRgbSchema { .. }
        | Error::RgbInspection { .. }
        | Error::UnsupportedSchema { .. }
        | Error::CannotUseSchemaOnMainnet { .. }
        | Error::FileTooLarge { .. } => invalid_contract(),
        // A storage or runtime failure does not establish invalid contract bytes.
        // Preserve the normal native failure class so callers can retry explicitly.
        other => native(other),
    }
}

impl Session {
    pub(super) fn import_contract(&mut self, request: Contract) -> Result<Value> {
        self.idle()?;
        require_asset(&request.expected_asset_id)?;
        if !lower_hex(&request.sha256, 64)
            || request.contract_base64.len() > MAX_CONTRACT.div_ceil(3) * 4
        {
            return Err(input("Invalid contract fingerprint or size."));
        }
        let bytes = STANDARD
            .decode(&request.contract_base64)
            .map_err(|_| input("Invalid contract base64."))?;
        if bytes.is_empty() || bytes.len() > MAX_CONTRACT || sha256(&bytes) != request.sha256 {
            return Err(fault(
                "CONTRACT_DIGEST_MISMATCH",
                "Contract bytes do not match their expected SHA-256.",
            ));
        }
        // Native paths stay private. Inspect the exact bounded bytes before importing:
        // upstream import does not take an expected ID and must not mutate a wrong asset.
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root).map_err(storage)?;
        temporary.write_all(&bytes).map_err(storage)?;
        temporary.flush().map_err(storage)?;
        let path = temporary
            .path()
            .to_str()
            .ok_or_else(invalid_contract)?
            .to_owned();
        let inspected =
            inspect_consignment(path.clone(), BundleFilter::All).map_err(import_error)?;
        if inspected.is_transfer || !inspected.witnesses.is_empty() {
            return Err(invalid_contract());
        }
        if inspected.asset_id != request.expected_asset_id {
            return Err(fault(
                "CONTRACT_ASSET_MISMATCH",
                "The public contract does not identify the expected RGB asset.",
            ));
        }
        // Inspection is not validation. Upstream validates the schema, genesis and chain
        // and atomically stores the contract without creating an allocation or transfer.
        // A duplicate is not evidence that the supplied bytes passed validation.
        self.wallet
            .import_contract(path, vec![])
            .map_err(import_error)?;
        Ok(json!({"assetId": request.expected_asset_id}))
    }

    pub(super) fn export_contract(&self, request: Asset) -> Result<Value> {
        self.idle()?;
        require_asset(&request.asset_id)?;
        let temporary = tempfile::tempdir_in(&self.root).map_err(storage)?;
        let directory = temporary
            .path()
            .to_str()
            .ok_or_else(invalid_contract)?
            .to_owned();
        let output = self
            .wallet
            .export_contract(request.asset_id.clone(), directory)
            .map_err(native)?;
        let path = Path::new(&output);
        if path.parent() != Some(temporary.path()) {
            return Err(invalid_contract());
        }
        let bytes = read_bounded(path, MAX_CONTRACT).map_err(|_| {
            fault(
                "CONTRACT_EXPORT_UNAVAILABLE",
                "The public contract exceeds the SDK export limit or cannot be read.",
            )
        })?;
        Ok(
            json!({"assetId": request.asset_id, "data": STANDARD.encode(&bytes), "sha256": sha256(&bytes)}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::{AssetSchema, Error};

    #[test]
    fn import_distinguishes_bad_contracts_from_wallet_failures() {
        for error in [
            Error::InvalidContract {
                file_path: "private/contract".into(),
            },
            Error::ConsignmentValidationFailed {
                details: "wrong chain or invalid genesis".into(),
            },
            Error::UnknownRgbSchema {
                schema_id: "unsupported schema".into(),
            },
            Error::RgbInspection {
                details: "malformed genesis".into(),
            },
            Error::UnsupportedSchema {
                asset_schema: AssetSchema::Bfa,
            },
            Error::CannotUseSchemaOnMainnet {
                asset_schema: AssetSchema::Bfa,
            },
        ] {
            assert_eq!(import_error(error).code, "CONTRACT_INVALID");
        }
        for error in [
            Error::IO {
                details: "disk full at private/wallet".into(),
            },
            Error::Database {
                details: "database locked".into(),
            },
            Error::Inconsistency {
                details: "retained stock is incomplete".into(),
            },
            Error::InvalidFilePath {
                file_path: "private/contract".into(),
            },
        ] {
            assert_eq!(import_error(error.clone()).code, native(error.clone()).code);
            assert_ne!(import_error(error).code, "CONTRACT_INVALID");
        }
        assert_eq!(
            import_error(Error::AssetAlreadyKnown {
                asset_id: "known".into()
            })
            .code,
            "ASSET_ALREADY_KNOWN"
        );
        assert_eq!(
            import_error(Error::InvalidAttachments {
                details: "missing media".into()
            })
            .code,
            "CONTRACT_MEDIA_REQUIRED"
        );
    }
}
