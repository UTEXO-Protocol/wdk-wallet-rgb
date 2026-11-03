// SPDX-License-Identifier: Apache-2.0
use crate::engine::{Credentials, Result, input, validated_url};
use rgb_lib::wallet::IndexerConfig;
use serde_json::{Value, json};
use zeroize::Zeroize;

pub(crate) fn version(source: &str, overlay: &str) -> Value {
    json!({
        "protocol": 2,
        "source": source,
        "overlayTree": overlay,
        "integrationTree": "8dd209a8bb849696e45f301b0ea1b3d4eb0fba06",
        "runtime": crate::RUNTIME,
        "indexer": "electrum-only",
    })
}

pub(crate) fn indexer(
    indexer_url: String,
    auth: Option<Credentials>,
    regtest: bool,
) -> Result<IndexerConfig> {
    if let Some(mut auth) = auth {
        auth.username.zeroize();
        auth.password.zeroize();
        return Err(input(
            "Bitcoin Core credentials are not supported by the Electrum profile.",
        ));
    }
    let url = validated_url(&indexer_url, &["ssl", "tcp"], regtest)?;
    if url.port().is_none() || url.query().is_some() || !matches!(url.path(), "" | "/") {
        return Err(input(
            "The Electrum endpoint requires an explicit port and no path or query.",
        ));
    }
    Ok(IndexerConfig::Electrum { url: indexer_url })
}

pub(crate) fn clear_indexer_credentials(_: &mut IndexerConfig) {}

pub(crate) fn after_wallet_new() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_electrum_with_plain_tcp_restricted_to_regtest() {
        assert!(indexer("tcp://127.0.0.1:48001".into(), None, true).is_ok());
        assert!(indexer("ssl://example.test:50002".into(), None, false).is_ok());
        for url in [
            "tcp://example.test:50001",
            "ssl://example.test",
            "ssl://example.test:50002/rpc",
            "ssl://example.test:50002?timeout=0",
            "ssl://name:pw@example.test:50002",
            "https://example.test:443",
            "http://127.0.0.1:8332",
        ] {
            assert!(indexer(url.into(), None, false).is_err(), "accepted {url}");
        }
        let credentials = Credentials {
            username: "user".into(),
            password: "pass".into(),
        };
        assert!(indexer("tcp://127.0.0.1:48001".into(), Some(credentials), true).is_err());
    }
}
