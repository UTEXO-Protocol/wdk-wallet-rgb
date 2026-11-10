// SPDX-License-Identifier: Apache-2.0
//! Durable SDK writes performed while this worker owns the wallet directory lock.
use super::{
    Deserialize, File, Result, Session, Value, decode, fault, input, json, read_bounded, storage,
};
use std::fs::{self, DirBuilder};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

const MAX_RECORD_BYTES: usize = 32_768;
const IDENTITY: &str = "identity.json";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Mode {
    #[default]
    Rgb,
    BtcOnly,
}

impl Mode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Rgb => "rgb",
            Self::BtcOnly => "btc-only",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Scope {
    Spend,
    Invoice,
    #[serde(skip)]
    Issuance,
}

impl Scope {
    fn directory(self) -> &'static str {
        match self {
            Self::Spend => ".wdk-onchain-journal-v1",
            Self::Invoice => ".wdk-onchain-invoices-v1",
            Self::Issuance => ".wdk-onchain-issuance-v1",
        }
    }

    fn record_id(self, record: &Value) -> Result<&str> {
        let id = record["id"].as_str().filter(|id| valid_operation_id(id));
        let kind = record["kind"].as_str();
        let scope_matches = match self {
            Self::Spend => matches!(
                kind,
                Some("rgb-output" | "btc-send" | "rgb-send" | "rgb-burn")
            ),
            Self::Invoice => kind == Some("rgb-receive"),
            Self::Issuance => false,
        };
        let stage_valid = matches!(
            record["stage"].as_str(),
            Some("starting" | "prepared" | "submitting" | "declined" | "submitted" | "failed")
        );
        id.filter(|_| scope_matches && stage_valid)
            .ok_or_else(|| input("Invalid wallet journal record."))
    }
}

pub(super) fn valid_operation_id(id: &str) -> bool {
    (16..=80).contains(&id.len())
        && id.bytes().enumerate().all(|(index, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || (index > 0 && b == b'-')
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bind {
    scope: Scope,
    identity: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    scope: Scope,
    record: Value,
}

pub(super) fn corrupt() -> super::Fault {
    fault("JOURNAL_CORRUPT", "Wallet journal storage requires review.")
}

fn record_file_exists(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(metadata)
            if metadata.is_file()
                && metadata.uid() == unsafe { libc::geteuid() }
                && metadata.permissions().mode() & 0o777 == 0o600
                && metadata.nlink() == 1
                && metadata.len() > 0
                && metadata.len() <= MAX_RECORD_BYTES as u64 =>
        {
            Ok(true)
        }
        Ok(_) => Err(corrupt()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage(error)),
    }
}

pub(super) fn read_record<T: super::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    if !record_file_exists(path)? {
        return Ok(None);
    }
    serde_json::from_slice(&super::read_bounded(path, MAX_RECORD_BYTES).map_err(storage)?)
        .map(Some)
        .map_err(|_| corrupt())
}

pub(super) fn commit(dir: &Path, path: PathBuf, record: &Value, creating_identity: bool) -> Result<()> {
    let data = serde_json::to_vec(record).map_err(|_| input("Invalid wallet journal data."))?;
    if data.len() >= MAX_RECORD_BYTES {
        return Err(input("Wallet journal record exceeds its size limit."));
    }
    let mut stage = tempfile::NamedTempFile::new_in(dir).map_err(storage)?;
    stage
        .write_all(&data)
        .and_then(|_| stage.write_all(b"\n"))
        .map_err(storage)?;
    stage.as_file().sync_all().map_err(storage)?;
    if creating_identity {
        stage
            .persist_noclobber(path)
            .map_err(|error| storage(error.error))?;
    } else {
        stage.persist(path).map_err(|error| storage(error.error))?;
    }
    File::open(dir)
        .and_then(|file| file.sync_all())
        .map_err(storage)
}

impl Session {
    fn journal_directory(&self, scope: Scope, create: bool) -> Result<PathBuf> {
        let path = self.root.join(scope.directory());
        if create {
            match DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(storage(error)),
            }
            File::open(&self.root)
                .and_then(|file| file.sync_all())
                .map_err(storage)?;
        }
        let metadata = path.symlink_metadata().map_err(storage)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o777 != 0o700
            || path.canonicalize().map_err(storage)? != path
        {
            return Err(corrupt());
        }
        Ok(path)
    }

    fn check_journal_identity(&self, path: &Path) -> Result<()> {
        if !record_file_exists(path)? {
            return Err(corrupt());
        }
        let current: Value =
            serde_json::from_slice(&read_bounded(path, MAX_RECORD_BYTES).map_err(storage)?)
                .map_err(|_| corrupt())?;
        let stored_mode = match current.get("mode") {
            Some(value) => value.as_str().ok_or_else(corrupt)?,
            None => "rgb", // Alpha.3 RGB identity records predate the mode field.
        };
        if stored_mode != self.journal_mode.as_str() {
            return Err(fault(
                "WALLET_MODE_MISMATCH",
                "Wallet directory belongs to another wallet mode.",
            ));
        }
        if current["identity"].as_str() != Some(&self.journal_identity) {
            return Err(fault(
                "WALLET_IDENTITY_MISMATCH",
                "Journal belongs to another wallet account.",
            ));
        }
        Ok(())
    }

    pub(super) fn bind_journal(&self, params: Value) -> Result<Value> {
        let p: Bind = decode(params)?;
        if p.identity != self.journal_identity {
            return Err(fault(
                "WALLET_IDENTITY_MISMATCH",
                "Journal belongs to another wallet account.",
            ));
        }
        self.bind_journal_scope(p.scope)?;
        Ok(json!({"written": true}))
    }

    pub(super) fn bind_journal_scope(&self, scope: Scope) -> Result<PathBuf> {
        let dir = self.journal_directory(scope, true)?;
        let identity = dir.join(IDENTITY);
        if record_file_exists(&identity)? {
            self.check_journal_identity(&identity)?;
        } else {
            for entry in fs::read_dir(&dir).map_err(storage)? {
                if entry
                    .map_err(storage)?
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "json")
                {
                    return Err(corrupt());
                }
            }
            commit(
                &dir,
                identity,
                &json!({"identity": self.journal_identity, "mode": self.journal_mode.as_str()}),
                true,
            )?;
        }
        Ok(dir)
    }

    pub(super) fn write_journal_record(&self, params: Value) -> Result<Value> {
        let p: Save = decode(params)?;
        let id = p.scope.record_id(&p.record)?;
        if self.journal_mode == Mode::BtcOnly && p.record["kind"].as_str() != Some("btc-send") {
            return Err(input("RGB journal records require RGB wallet mode."));
        }
        if self.transport_endpoint.is_some() && p.record["kind"].as_str() == Some("rgb-burn") {
            return Err(super::bridge_unavailable());
        }
        let dir = self.journal_directory(p.scope, false)?;
        self.check_journal_identity(&dir.join(IDENTITY))?;
        let target = dir.join(format!("{id}.json"));
        record_file_exists(&target)?;
        commit(&dir, target, &p.record, false)?;
        Ok(json!({"written": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_scopes_reject_untrusted_names_and_wrong_record_kinds() {
        for id in [
            "../../other-wallet",
            "identity.json",
            "a",
            "-starts-with-hyphen",
            "wrong_CASE_0123456789",
        ] {
            assert!(
                Scope::Spend
                    .record_id(&json!({"id":id,"kind":"btc-send","stage":"starting"}))
                    .is_err()
            );
        }
        let valid = json!({"id":"valid-operation-123","kind":"btc-send","stage":"starting"});
        assert_eq!(
            Scope::Spend.record_id(&valid).unwrap(),
            "valid-operation-123"
        );
        assert!(Scope::Invoice.record_id(&valid).is_err());
    }
}
