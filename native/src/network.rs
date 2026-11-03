// SPDX-License-Identifier: Apache-2.0
use super::{
    Empty, Result, Session, Value, bitcoin_chain, decode, fault, json, native, validate_proxy,
};
use electrum_client::{Client, ConfigBuilder, ElectrumApi};
use rgb_lib::bitcoin::constants::genesis_block;
use rgb_lib::wallet::{IndexerConfig, IndexerProtocol, TransportEndpoint, check_indexer_url};
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

const PROXY_INFO_LIMIT: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    url: String,
}

impl Session {
    pub(super) fn network_info(&self, params: Value) -> Result<Value> {
        let _: Empty = decode(params)?;
        self.online()?;
        let url = self.indexer_url.as_deref().ok_or_else(|| {
            fault(
                "WALLET_OFFLINE",
                "The RGB wallet has no online indexer session.",
            )
        })?;
        let unavailable = |_| {
            fault(
                "INDEXER_UNAVAILABLE",
                "Unable to read the Bitcoin chain tip.",
            )
        };
        let client = Client::from_config(
            url,
            ConfigBuilder::new()
                .timeout(Some(Duration::from_secs(5)))
                .retry(0)
                .validate_domain(true)
                .build(),
        )
        .map_err(unavailable)?;
        let expected = genesis_block(bitcoin_chain(self.network)).block_hash();
        if client.block_header(0).map_err(unavailable)?.block_hash() != expected {
            return Err(fault(
                "INVALID_INDEXER",
                "The indexer reports a different Bitcoin network.",
            ));
        }
        let tip = client.block_headers_subscribe().map_err(unavailable)?;
        let height = u32::try_from(tip.height).map_err(|_| {
            fault(
                "INVALID_INDEXER",
                "The indexer returned an invalid block height.",
            )
        })?;
        let block_hash = tip.header.block_hash();
        if height == 0 && block_hash != expected {
            return Err(fault(
                "INVALID_INDEXER",
                "The indexer returned an invalid genesis tip.",
            ));
        }
        Ok(json!({
            "network": format!("{:?}", self.network).to_lowercase(),
            "height": height,
            "blockHash": block_hash.to_string(),
        }))
    }

    pub(super) fn check_indexer(&self, params: Value) -> Result<Value> {
        let p: Endpoint = decode(params)?;
        let config = crate::profile::indexer(
            p.url,
            None,
            self.network == rgb_lib::BitcoinNetwork::Regtest,
        )?;
        let IndexerConfig::Electrum { url } = config else {
            unreachable!("the profile admits only Electrum");
        };
        if check_indexer_url(&url, None, self.network).map_err(native)? != IndexerProtocol::Electrum
        {
            return Err(fault(
                "INVALID_INDEXER",
                "The endpoint is not an Electrum indexer.",
            ));
        }
        Ok(json!({"ok":true, "indexerProtocol":"Electrum"}))
    }

    pub(super) fn check_proxy(&self, params: Value) -> Result<Value> {
        let p: Endpoint = decode(params)?;
        validate_proxy(&p.url, self.network == rgb_lib::BitcoinNetwork::Regtest)?;
        let proxy = TransportEndpoint::new(p.url).map_err(native)?;
        // This health probe never follows redirects or transmits proxy authorization.
        // Its own short timeout and response bound keep a bad probe from closing the worker.
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| proxy_unavailable())?;
        let response = client
            .post(&proxy.endpoint)
            .timeout(Duration::from_secs(5))
            .json(&json!({"jsonrpc":"2.0", "id":null, "method":"server.info"}))
            .send()
            .map_err(|_| proxy_unavailable())?;
        if !response.status().is_success() {
            return Err(proxy_unavailable());
        }
        let mut body = Vec::new();
        response
            .take(PROXY_INFO_LIMIT + 1)
            .read_to_end(&mut body)
            .map_err(|_| proxy_unavailable())?;
        let protocol = proxy_protocol(&body)?;
        if protocol != "1.0" {
            return Err(fault(
                "INVALID_PROXY_PROTOCOL",
                "The RGB proxy does not support the required protocol.",
            ));
        }
        Ok(json!({"ok":true}))
    }
}

fn proxy_unavailable() -> super::Fault {
    fault("PROXY_UNAVAILABLE", "Unable to verify the RGB proxy.")
}

fn proxy_protocol(bytes: &[u8]) -> Result<String> {
    if bytes.len() as u64 > PROXY_INFO_LIMIT {
        return Err(proxy_unavailable());
    }
    let response: Value = serde_json::from_slice(bytes).map_err(|_| proxy_unavailable())?;
    let result = &response["result"];
    if response["jsonrpc"] != "2.0"
        || response.get("id") != Some(&Value::Null)
        || !response["error"].is_null()
        || result["version"].as_str().is_none_or(str::is_empty)
        || result["uptime"].as_i64().is_none_or(|uptime| uptime < 0)
    {
        return Err(proxy_unavailable());
    }
    result["protocol_version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
        .ok_or_else(proxy_unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_check_requires_a_bounded_matching_server_info_envelope() {
        let good = br#"{"jsonrpc":"2.0","id":null,"result":{"version":"0.4.0","uptime":0,"protocol_version":"1.0"}}"#;
        assert_eq!(proxy_protocol(good).unwrap(), "1.0");
        for invalid in [
            br#"{"jsonrpc":"2.0","result":{"version":"0.4.0","uptime":0,"protocol_version":"1.0"}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":1,"result":{"version":"0.4.0","uptime":0,"protocol_version":"1.0"}}"#,
            br#"{"jsonrpc":"2.0","id":null,"error":{"message":"denied"},"result":{"version":"0.4.0","uptime":0,"protocol_version":"1.0"}}"#,
            br#"{"jsonrpc":"2.0","id":null,"result":{"version":"0.4.0","uptime":0,"protocol_version":1}}"#,
            br#"{"jsonrpc":"2.0","id":null,"result":{"version":"0.4.0","uptime":-1,"protocol_version":"1.0"}}"#,
        ] {
            assert_eq!(proxy_protocol(invalid).unwrap_err().code, "PROXY_UNAVAILABLE");
        }
        let mut oversized = good.to_vec();
        oversized.resize(PROXY_INFO_LIMIT as usize + 1, b' ');
        assert_eq!(
            proxy_protocol(&oversized).unwrap_err().code,
            "PROXY_UNAVAILABLE"
        );
    }
}
