// SPDX-License-Identifier: Apache-2.0
use crate::engine::{Credentials, Result, input, validated_url};
use rgb_lib::BitcoinNetwork;
use rgb_lib::wallet::IndexerConfig;
use serde_json::{Value, json};
use zeroize::Zeroize;

const SIGNET_ELECTRUM: &str = "ssl://electrum.iriswallet.com:50033";

pub(crate) fn version(source: &str, overlay: &str) -> Value {
    json!({
        "protocol": 2,
        "source": source,
        "overlayTree": overlay,
        "integrationTree": "9c562a793e484c433a6a10ae58a6cd76c8a70b11",
        "runtime": crate::RUNTIME,
        "indexer": "electrum-only",
        "networkChecks": 2,
        "unsignedRecovery": 1,
        "journalWrites": 1,
    })
}

pub(crate) fn indexer(
    indexer_url: String,
    auth: Option<Credentials>,
    network: BitcoinNetwork,
) -> Result<IndexerConfig> {
    if let Some(mut auth) = auth {
        auth.username.zeroize();
        auth.password.zeroize();
        return Err(input(
            "Bitcoin Core credentials are not supported by the Electrum profile.",
        ));
    }
    if network == BitcoinNetwork::Signet {
        if indexer_url.strip_suffix('/').unwrap_or(&indexer_url) != SIGNET_ELECTRUM {
            return Err(input("Public Signet requires the approved TLS Electrum endpoint."));
        }
        return Ok(IndexerConfig::Electrum { url: SIGNET_ELECTRUM.into() });
    }
    if network != BitcoinNetwork::Regtest {
        return Err(input("Unsupported Bitcoin network."));
    }
    let url = validated_url(&indexer_url, &["ssl", "tcp"], true)?;
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return Err(input("The Electrum endpoint requires an explicit host and port."));
    };
    if !matches!(url.path(), "" | "/") {
        return Err(input(
            "The Electrum endpoint requires an explicit port and no path or query.",
        ));
    }
    Ok(IndexerConfig::Electrum {
        url: format!("{}://{host}:{port}", url.scheme()),
    })
}

pub(crate) fn clear_indexer_credentials(_: &mut IndexerConfig) {}

pub(crate) fn after_wallet_new() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_electrum_with_plain_tcp_restricted_to_regtest() {
        let regtest = BitcoinNetwork::Regtest;
        let signet = BitcoinNetwork::Signet;
        assert!(indexer("tcp://127.0.0.1:48001".into(), None, regtest).is_ok());
        assert_eq!(indexer(format!("{SIGNET_ELECTRUM}/"), None, signet).unwrap().url(), SIGNET_ELECTRUM);
        assert!(indexer(SIGNET_ELECTRUM.into(), None, regtest).is_err());
        for url in [
            "tcp://example.test:50001",
            "tcp://electrum.iriswallet.com:50033",
            "ssl://electrum.iriswallet.com:50033//",
            "ssl://electrum.iriswallet.com:50033?",
            "ssl://example.test",
            "ssl://example.test:50002",
            "ssl://example.test:50002/rpc",
            "ssl://example.test:50002?timeout=0",
            "ssl://name:pw@example.test:50002",
            "https://example.test:443",
            "http://127.0.0.1:8332",
        ] {
            assert!(indexer(url.into(), None, signet).is_err(), "accepted {url}");
        }
        let credentials = Credentials {
            username: "user".into(),
            password: "pass".into(),
        };
        assert!(indexer("tcp://127.0.0.1:48001".into(), Some(credentials), regtest).is_err());
    }
}
