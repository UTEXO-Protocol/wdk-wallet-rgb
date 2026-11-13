// SPDX-License-Identifier: Apache-2.0
use super::{Empty, Result, Session, Value, bitcoin_chain, decode, fault, json, native};
use crate::profile::{Profile, SignetCheckpoint, signet_checkpoint};
use electrum_client::{Client, ConfigBuilder, ElectrumApi};
use rgb_lib::BitcoinNetwork;
use rgb_lib::bitcoin::BlockHash;
use rgb_lib::bitcoin::constants::genesis_block;
use rgb_lib::wallet::{IndexerConfig, IndexerProtocol, TransportEndpoint, check_indexer_url};
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

const PROXY_INFO_LIMIT: u64 = 16 * 1024;
const CHAIN_RESPONSE_LIMIT: u64 = 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Endpoint {
    url: String,
}

fn invalid_indexer() -> super::Fault {
    fault(
        "INVALID_INDEXER",
        "The indexer reports a different or invalid Bitcoin chain.",
    )
}

fn indexer_unavailable() -> super::Fault {
    fault(
        "INDEXER_UNAVAILABLE",
        "Unable to read the Bitcoin chain tip.",
    )
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
        return Err(invalid_indexer());
    }
    Ok(())
}

fn verify_tip(
    genesis: BlockHash,
    block_one: Option<BlockHash>,
    height: u32,
    block_hash: BlockHash,
) -> Result<()> {
    if (height == 0 && (block_one.is_some() || block_hash != genesis))
        || (height == 1 && block_one.is_some_and(|expected| block_hash != expected))
    {
        return Err(invalid_indexer());
    }
    Ok(())
}

fn probe_client(timeout: u64) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|_| indexer_unavailable())
}

fn bounded_text(client: &reqwest::blocking::Client, url: &str) -> Result<String> {
    let response = client.get(url).send().map_err(|_| indexer_unavailable())?;
    if !response.status().is_success() {
        return Err(indexer_unavailable());
    }
    let mut body = Vec::new();
    response
        .take(CHAIN_RESPONSE_LIMIT + 1)
        .read_to_end(&mut body)
        .map_err(|_| indexer_unavailable())?;
    if body.len() as u64 > CHAIN_RESPONSE_LIMIT {
        return Err(invalid_indexer());
    }
    String::from_utf8(body).map_err(|_| invalid_indexer())
}

fn esplora_hash_at(
    client: &reqwest::blocking::Client,
    url: &str,
    height: u32,
) -> Result<BlockHash> {
    bounded_text(
        client,
        &format!("{}/block-height/{height}", url.trim_end_matches('/')),
    )?
    .trim()
    .parse()
    .map_err(|_| invalid_indexer())
}

fn esplora_identity(
    client: &reqwest::blocking::Client,
    url: &str,
    network: BitcoinNetwork,
    checkpoint: SignetCheckpoint,
) -> Result<(BlockHash, Option<BlockHash>)> {
    let genesis = esplora_hash_at(client, url, 0)?;
    let block_one = if network == BitcoinNetwork::Signet {
        Some(esplora_hash_at(client, url, 1)?)
    } else {
        None
    };
    verify_chain(network, checkpoint, genesis, block_one)?;
    Ok((genesis, block_one))
}

fn esplora_chain_tip(
    client: &reqwest::blocking::Client,
    url: &str,
    network: BitcoinNetwork,
    checkpoint: SignetCheckpoint,
) -> Result<(u32, BlockHash)> {
    let (genesis, block_one) = esplora_identity(client, url, network, checkpoint)?;
    let height: u32 = bounded_text(
        client,
        &format!("{}/blocks/tip/height", url.trim_end_matches('/')),
    )?
    .trim()
    .parse()
    .map_err(|_| invalid_indexer())?;
    let hash = esplora_hash_at(client, url, height)?;
    verify_tip(genesis, block_one, height, hash)?;
    Ok((height, hash))
}

fn electrum_client(url: &str) -> Result<Client> {
    // A preflight is a new, bounded read-only connection. Stock rgb-lib owns its
    // separate wallet/resolver clients and their retry policy; this does not
    // install checkpoint enforcement inside those clients.
    Client::from_config(
        url,
        ConfigBuilder::new()
            .timeout(Some(Duration::from_secs(5)))
            .retry(0)
            .validate_domain(true)
            .build(),
    )
    .map_err(|_| indexer_unavailable())
}

fn electrum_identity(
    client: &Client,
    network: BitcoinNetwork,
    checkpoint: SignetCheckpoint,
) -> Result<(BlockHash, Option<BlockHash>)> {
    let genesis = client
        .block_header(0)
        .map_err(|_| indexer_unavailable())?
        .block_hash();
    let block_one = if network == BitcoinNetwork::Signet {
        Some(
            client
                .block_header(1)
                .map_err(|_| indexer_unavailable())?
                .block_hash(),
        )
    } else {
        None
    };
    verify_chain(network, checkpoint, genesis, block_one)?;
    Ok((genesis, block_one))
}

fn electrum_chain_tip(
    url: &str,
    network: BitcoinNetwork,
    checkpoint: SignetCheckpoint,
) -> Result<(u32, BlockHash)> {
    let client = electrum_client(url)?;
    let (genesis, block_one) = electrum_identity(&client, network, checkpoint)?;
    let tip = client
        .block_headers_subscribe()
        .map_err(|_| indexer_unavailable())?;
    let height = u32::try_from(tip.height).map_err(|_| invalid_indexer())?;
    let hash = tip.header.block_hash();
    verify_tip(genesis, block_one, height, hash)?;
    Ok((height, hash))
}

fn chain_tip(
    config: &IndexerConfig,
    network: BitcoinNetwork,
    profile: Option<Profile>,
) -> Result<(u32, BlockHash)> {
    let checkpoint = signet_checkpoint(profile);
    match config {
        IndexerConfig::Electrum { url } => electrum_chain_tip(url, network, checkpoint),
        IndexerConfig::Esplora { url } => {
            esplora_chain_tip(&probe_client(5)?, url, network, checkpoint)
        }
        _ => Err(invalid_indexer()),
    }
}

/// Recheck the selected chain at a WDK operation boundary. This is deliberately
/// separate from stock rgb-lib's internal resolver and reconnect behavior.
pub(super) fn check_indexer_chain(
    config: &IndexerConfig,
    network: BitcoinNetwork,
    profile: Option<Profile>,
) -> Result<()> {
    let checkpoint = signet_checkpoint(profile);
    // Identity reads suffice before an operation. Do not add a second tip sync
    // to every send/refresh; the native operation performs its own chain sync.
    match config {
        IndexerConfig::Electrum { url } => {
            electrum_identity(&electrum_client(url)?, network, checkpoint)
        }
        IndexerConfig::Esplora { url } => {
            esplora_identity(&probe_client(5)?, url, network, checkpoint)
        }
        _ => return Err(invalid_indexer()),
    }
    .map(|_| ())
}

impl Session {
    pub(super) fn network_info(&self, params: Value) -> Result<Value> {
        let _: Empty = decode(params)?;
        self.online()?;
        let url = self.indexer_url.as_ref().ok_or_else(|| {
            fault(
                "WALLET_OFFLINE",
                "The RGB wallet has no online indexer session.",
            )
        })?;
        let config = crate::profile::indexer(url.clone(), None, self.network, self.profile)?;
        let (height, hash) = chain_tip(&config, self.network, self.profile)?;
        Ok(json!({
            "network": format!("{:?}", self.network).to_lowercase(),
            "height": height,
            "blockHash": hash.to_string(),
        }))
    }

    pub(super) fn check_indexer(&self, params: Value) -> Result<Value> {
        let p: Endpoint = decode(params)?;
        let config = crate::profile::indexer(p.url, None, self.network, self.profile)?;
        check_indexer_chain(&config, self.network, self.profile)?;
        let protocol = check_indexer_url(config.url(), None, self.network).map_err(native)?;
        if protocol != config.protocol() {
            return Err(invalid_indexer());
        }
        let protocol_name = match protocol {
            IndexerProtocol::Esplora => "Esplora",
            IndexerProtocol::Electrum => "Electrum",
            _ => return Err(invalid_indexer()),
        };
        Ok(json!({"ok":true, "indexerProtocol":protocol_name}))
    }

    pub(super) fn check_proxy(&self, params: Value) -> Result<Value> {
        let p: Endpoint = decode(params)?;
        self.validate_wallet_proxy(&p.url)?;
        let proxy = TransportEndpoint::new(p.url).map_err(native)?;
        // This WDK health probe never follows redirects or transmits proxy
        // authorization. Stock rgb-lib has its own HTTP clients for transfers.
        let client = probe_client(5).map_err(|_| proxy_unavailable())?;
        let response = client
            .post(&proxy.endpoint)
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
        if proxy_protocol(&body)? != "1.0" {
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
        let public = SignetCheckpoint::Public.block_one().parse().unwrap();
        let dev = SignetCheckpoint::Dev.block_one().parse().unwrap();
        let regtest_genesis = genesis_block(bitcoin_chain(BitcoinNetwork::Regtest)).block_hash();
        for (profile, expected, other) in [
            (None, public, dev),
            (Some(Profile::Public), public, dev),
            (Some(Profile::Staging), public, dev),
            (Some(Profile::Dev), dev, public),
        ] {
            let checkpoint = signet_checkpoint(profile);
            assert!(verify_chain(network, checkpoint, genesis, Some(expected)).is_ok());
            assert!(verify_chain(network, checkpoint, genesis, Some(other)).is_err());
            assert!(verify_chain(network, checkpoint, genesis, None).is_err());
            assert!(verify_chain(network, checkpoint, regtest_genesis, Some(expected)).is_err());
        }
        for network in [BitcoinNetwork::Regtest, BitcoinNetwork::Mainnet] {
            let genesis = genesis_block(bitcoin_chain(network)).block_hash();
            assert!(verify_chain(network, SignetCheckpoint::Public, genesis, None).is_ok());
            assert!(verify_tip(genesis, None, 0, genesis).is_ok());
        }
        assert!(verify_tip(genesis, Some(dev), 0, genesis).is_err());
        assert!(verify_tip(genesis, Some(dev), 1, public).is_err());
    }

    #[test]
    fn wdk_preflight_rejects_wrong_genesis_before_reading_a_tip() {
        use rgb_lib::bitcoin::consensus::encode::serialize_hex;
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("tcp://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            let handshake: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(handshake["method"], "server.version");
            let response = json!({"jsonrpc":"2.0","id":handshake["id"],"result":["fixture","1.4"]});
            writeln!(stream.get_mut(), "{response}").unwrap();
            line.clear();
            stream.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "blockchain.block.header");
            assert_eq!(request["params"], json!([0]));
            let wrong_header = genesis_block(bitcoin_chain(BitcoinNetwork::Regtest)).header;
            let response =
                json!({"jsonrpc":"2.0","id":request["id"],"result":serialize_hex(&wrong_header)});
            writeln!(stream.get_mut(), "{response}").unwrap();
            line.clear();
            assert_eq!(stream.read_line(&mut line).unwrap(), 0);
        });
        let error = check_indexer_chain(
            &IndexerConfig::Electrum { url },
            BitcoinNetwork::Mainnet,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_INDEXER");
        server.join().unwrap();
    }

    #[test]
    fn dev_esplora_preflight_rejects_public_signet_before_reading_the_tip() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (path, value) in [
                (
                    "/block-height/0",
                    genesis_block(bitcoin_chain(BitcoinNetwork::Signet))
                        .block_hash()
                        .to_string(),
                ),
                (
                    "/block-height/1",
                    SignetCheckpoint::Public.block_one().to_owned(),
                ),
            ] {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).unwrap();
                assert_eq!(line, format!("GET {path} HTTP/1.1\r\n"));
                loop {
                    line.clear();
                    stream.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(
                    stream.get_mut(),
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{value}",
                    value.len()
                )
                .unwrap();
            }
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        });
        let error = esplora_chain_tip(
            &probe_client(2).unwrap(),
            &url,
            BitcoinNetwork::Signet,
            SignetCheckpoint::Dev,
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_INDEXER");
        server.join().unwrap();
    }

    fn serve_http_responses(
        responses: Vec<(&'static str, u16, String)>,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (path, status, body) in responses {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).unwrap();
                assert_eq!(line, format!("GET {path} HTTP/1.1\r\n"));
                loop {
                    line.clear();
                    assert_ne!(stream.read_line(&mut line).unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                }
                write!(stream.get_mut(), "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\nLocation: /unexpected-redirect\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (url, server)
    }

    #[test]
    fn dev_esplora_preflight_accepts_its_checkpoint_and_consistent_tip() {
        let genesis = genesis_block(bitcoin_chain(BitcoinNetwork::Signet)).block_hash();
        let dev = SignetCheckpoint::Dev.block_one();
        let (url, server) = serve_http_responses(vec![
            ("/block-height/0", 200, genesis.to_string()),
            ("/block-height/1", 200, dev.to_owned()),
            ("/blocks/tip/height", 200, "1\n".into()),
            ("/block-height/1", 200, dev.to_owned()),
        ]);
        let (height, hash) = esplora_chain_tip(
            &probe_client(2).unwrap(),
            &url,
            BitcoinNetwork::Signet,
            SignetCheckpoint::Dev,
        )
        .unwrap();
        assert_eq!(height, 1);
        assert_eq!(hash.to_string(), dev);
        server.join().unwrap();
    }

    #[test]
    fn dev_operation_preflight_checks_identity_without_redundant_tip_requests() {
        let genesis = genesis_block(bitcoin_chain(BitcoinNetwork::Signet)).block_hash();
        let (url, server) = serve_http_responses(vec![
            ("/block-height/0", 200, genesis.to_string()),
            (
                "/block-height/1",
                200,
                SignetCheckpoint::Dev.block_one().into(),
            ),
        ]);
        check_indexer_chain(
            &IndexerConfig::Esplora { url },
            BitcoinNetwork::Signet,
            Some(Profile::Dev),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn esplora_probe_rejects_redirects_oversized_and_malformed_responses() {
        for (status, body, code) in [
            (302, "redirect".to_owned(), "INDEXER_UNAVAILABLE"),
            (
                200,
                "a".repeat(CHAIN_RESPONSE_LIMIT as usize + 1),
                "INVALID_INDEXER",
            ),
            (200, "not-a-bitcoin-hash".to_owned(), "INVALID_INDEXER"),
        ] {
            let (url, server) = serve_http_responses(vec![("/block-height/0", status, body)]);
            let result = esplora_chain_tip(
                &probe_client(2).unwrap(),
                &url,
                BitcoinNetwork::Signet,
                SignetCheckpoint::Dev,
            );
            assert_eq!(result.unwrap_err().code, code);
            server.join().unwrap();
        }
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
