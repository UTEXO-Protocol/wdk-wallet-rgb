// SPDX-License-Identifier: Apache-2.0
use super::{
    Empty, Result, Session, Value, bitcoin_chain, decode, fault, json, native,
};
use electrum_client::{Client, ConfigBuilder, ElectrumApi};
use rgb_lib::BitcoinNetwork;
use rgb_lib::bitcoin::BlockHash;
use rgb_lib::bitcoin::constants::genesis_block;
use rgb_lib::no_wallet::SignetCheckpoint;
use rgb_lib::wallet::rust_only::wallet_http_client_for_network;
use rgb_lib::wallet::{
    IndexerConfig, IndexerProtocol, TransportEndpoint, check_dev_esplora_tip, check_indexer_config,
};
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

const PROXY_INFO_LIMIT: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    url: String,
}

fn verify_chain(
    network: BitcoinNetwork,
    checkpoint: SignetCheckpoint,
    genesis: BlockHash,
    block_one: Option<BlockHash>,
) -> Result<()> {
    if genesis != genesis_block(bitcoin_chain(network)).block_hash()
        || (network == BitcoinNetwork::Signet
            && !block_one.is_some_and(|hash| hash.to_string() == checkpoint.block_one()))
    {
        return Err(fault(
            "INVALID_INDEXER",
            "The indexer reports a different Bitcoin network.",
        ));
    }
    Ok(())
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
        if matches!(self.profile, Some(crate::profile::Profile::Dev)) {
            let (height, hash) = check_dev_esplora_tip(url).map_err(native)?;
            return Ok(json!({"network":"signet", "height":height, "blockHash":hash}));
        }
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
        let genesis = client.block_header(0).map_err(unavailable)?.block_hash();
        let block_one = if self.network == BitcoinNetwork::Signet {
            Some(client.block_header(1).map_err(unavailable)?.block_hash())
        } else {
            None
        };
        verify_chain(
            self.network,
            crate::profile::signet_checkpoint(self.profile),
            genesis,
            block_one,
        )?;
        let tip = client.block_headers_subscribe().map_err(unavailable)?;
        let height = u32::try_from(tip.height).map_err(|_| {
            fault(
                "INVALID_INDEXER",
                "The indexer returned an invalid block height.",
            )
        })?;
        let block_hash = tip.header.block_hash();
        if (height == 0 && (block_one.is_some() || block_hash != genesis))
            || (height == 1 && block_one.is_some_and(|expected| block_hash != expected))
        {
            return Err(fault(
                "INVALID_INDEXER",
                "The indexer returned an invalid Bitcoin chain tip.",
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
        let config = crate::profile::indexer(p.url, None, self.network, self.profile)?;
        let protocol = match &config {
            IndexerConfig::DevSignetEsplora { .. } => IndexerProtocol::Esplora,
            _ => IndexerProtocol::Electrum,
        };
        if check_indexer_config(&config, self.network).map_err(native)? != protocol {
            return Err(fault(
                "INVALID_INDEXER",
                "The endpoint did not match the wallet's indexer protocol.",
            ));
        }
        let protocol_name = match protocol {
            IndexerProtocol::Esplora => "Esplora",
            _ => "Electrum",
        };
        Ok(json!({"ok":true, "indexerProtocol":protocol_name}))
    }

    pub(super) fn check_proxy(&self, params: Value) -> Result<Value> {
        let p: Endpoint = decode(params)?;
        self.validate_wallet_proxy(&p.url)?;
        let proxy = TransportEndpoint::new(p.url).map_err(native)?;
        // This health probe never follows redirects or transmits proxy authorization.
        // Its own short timeout and response bound keep a bad probe from closing the worker.
        let (client, url) = wallet_http_client_for_network(
            &proxy.endpoint,
            self.network,
            Duration::from_secs(3),
            Duration::from_secs(5),
        )
        .map_err(|_| proxy_unavailable())?;
        let response = client
            .post(url)
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
    fn signet_profiles_require_their_own_block_one_and_the_signet_genesis() {
        let network = BitcoinNetwork::Signet;
        let genesis = genesis_block(bitcoin_chain(network)).block_hash();
        let public = "00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53".parse().unwrap();
        let dev = "0000001b808e4ece11c0cd922eaf9eee8d7dfba7e23e90b4f9614248daaf72cb".parse().unwrap();
        let regtest_genesis = genesis_block(bitcoin_chain(BitcoinNetwork::Regtest)).block_hash();
        for (profile, expected, other) in [
            (None, public, dev),
            (Some(crate::profile::Profile::Public), public, dev),
            (Some(crate::profile::Profile::Staging), public, dev),
            (Some(crate::profile::Profile::Dev), dev, public),
        ] {
            let checkpoint = crate::profile::signet_checkpoint(profile);
            assert!(verify_chain(network, checkpoint, genesis, Some(expected)).is_ok());
            assert!(verify_chain(network, checkpoint, genesis, Some(other)).is_err());
            assert!(verify_chain(network, checkpoint, genesis, None).is_err());
            assert!(verify_chain(network, checkpoint, regtest_genesis, Some(expected)).is_err());
        }
        assert!(
            verify_chain(
                BitcoinNetwork::Regtest,
                SignetCheckpoint::Public,
                regtest_genesis,
                None,
            )
            .is_ok()
        );
    }

    #[test]
    fn mainnet_admission_rejects_wrong_genesis_on_the_wallet_indexer_socket() {
        use rgb_lib::bitcoin::consensus::encode::serialize_hex;
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("tcp://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "blockchain.block.header");
            assert_eq!(request["params"], json!([0]));
            let wrong_header = genesis_block(bitcoin_chain(BitcoinNetwork::Regtest)).header;
            let response = json!({"jsonrpc":"2.0","id":request["id"],"result":serialize_hex(&wrong_header)});
            writeln!(stream.get_mut(), "{response}").unwrap();
        });
        // Exercise the real underlying wallet indexer with a local server. The
        // public adapter itself only admits the pinned TLS Mainnet endpoint.
        let error = check_indexer_config(&IndexerConfig::Electrum { url }, BitcoinNetwork::Mainnet).unwrap_err();
        assert!(matches!(error, rgb_lib::Error::InvalidIndexer { details }
            if details == "the wallet indexer reports a different Bitcoin chain"));
        server.join().unwrap();
    }

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
