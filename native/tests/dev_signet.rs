// SPDX-License-Identifier: Apache-2.0
use rgb_lib::bitcoin::{Network, consensus::encode::serialize_hex, constants::genesis_block};
use rgb_lib::wallet::{IndexerConfig, IndexerProtocol, check_indexer_config};
use rgb_lib::{BitcoinNetwork, Error};
use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

const PUBLIC_BLOCK_ONE: &str = "00000020f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000f575c83235984e7dc4afc1f30944c170462e84437ab6f2d52e16878a79e4678bd1914d5fae77031eccf40700";
const DEV_BLOCK_ONE: &str = "00000020f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000ff4f693674163783e85d4c1c57205c20804084d70447bd224cf95f8c08510f00fe1c8069ae77031e22260200";
const PUBLIC_PROBE_TXID: &str = "8153034f45e695453250a8fb7225a5e545144071d8ed7b0d3211efa1f3c92ad8";

#[derive(Debug, PartialEq, Eq)]
enum Request {
    ServerVersion,
    Genesis,
    BlockOne,
    Transaction,
    VerboseTransaction,
}

fn serve(
    stream: TcpStream,
    genesis: &str,
    block_one: Option<&str>,
    requests: &Mutex<Vec<Request>>,
) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut stream = BufReader::new(stream);
    let mut line = String::new();
    while stream.read_line(&mut line)? != 0 {
        let request: Value = serde_json::from_str(&line)?;
        let result = match (request["method"].as_str(), &request["params"]) {
            (Some("server.version"), _) => {
                requests.lock().unwrap().push(Request::ServerVersion);
                Some(json!(["local-checkpoint-fixture", "1.6"]))
            }
            (Some("blockchain.block.header"), params) if params == &json!([0]) => {
                requests.lock().unwrap().push(Request::Genesis);
                Some(json!(genesis))
            }
            (Some("blockchain.block.header"), params) if params == &json!([1]) => {
                requests.lock().unwrap().push(Request::BlockOne);
                block_one.map(|header| json!(header))
            }
            (Some("blockchain.transaction.get"), params)
                if params == &json!([PUBLIC_PROBE_TXID, false]) =>
            {
                requests.lock().unwrap().push(Request::Transaction);
                Some(json!("00"))
            }
            (Some("blockchain.transaction.get"), params)
                if params == &json!([PUBLIC_PROBE_TXID, true]) =>
            {
                requests.lock().unwrap().push(Request::VerboseTransaction);
                Some(json!({"hex": "00"}))
            }
            _ => None,
        };
        let response = match result {
            Some(result) => json!({"jsonrpc": "2.0", "id": request["id"], "result": result}),
            None => json!({"jsonrpc": "2.0", "id": request["id"], "error": {
                "code": -32602, "message": "Request is unavailable in this local fixture"
            }}),
        };
        writeln!(stream.get_mut(), "{response}")?;
        line.clear();
    }
    Ok(())
}

fn check_public_fixture(
    genesis_network: Network,
    indexer_block_one: Option<&str>,
    resolver_block_one: Option<&str>,
) -> (Result<IndexerProtocol, Error>, Vec<Request>) {
    let genesis = serialize_hex(&genesis_block(genesis_network).header);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("tcp://{}", listener.local_addr().unwrap());
    let requests = Mutex::new(Vec::new());
    let (stop, finished) = mpsc::channel::<()>();
    let result = thread::scope(|scope| {
        let requests = &requests;
        let genesis = &genesis;
        let server = scope.spawn(move || {
            thread::scope(|connections| {
                let mut first_connection = true;
                while let Err(mpsc::RecvTimeoutError::Timeout) =
                    finished.recv_timeout(Duration::from_millis(2))
                {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let block_one = if first_connection {
                                indexer_block_one
                            } else {
                                resolver_block_one
                            };
                            first_connection = false;
                            connections.spawn(move || {
                                serve(stream, genesis, block_one, requests).unwrap();
                            });
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                        Err(error) => panic!("Fixture accept failed: {error}"),
                    }
                }
            });
        });
        let result = check_indexer_config(&IndexerConfig::Electrum { url }, BitcoinNetwork::Signet);
        drop(stop);
        server.join().unwrap();
        result
    });
    (result, requests.into_inner().unwrap())
}

#[test]
fn public_signet_checks_its_checkpoint_on_the_indexer_and_resolver() {
    let (result, requests) = check_public_fixture(
        Network::Signet,
        Some(PUBLIC_BLOCK_ONE),
        Some(PUBLIC_BLOCK_ONE),
    );
    assert!(
        matches!(result, Ok(IndexerProtocol::Electrum)),
        "{result:?}"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| **r == Request::ServerVersion)
            .count(),
        2
    );
    assert_eq!(
        requests.iter().filter(|r| **r == Request::Genesis).count(),
        2
    );
    assert_eq!(
        requests.iter().filter(|r| **r == Request::BlockOne).count(),
        2
    );
    assert!(requests.contains(&Request::VerboseTransaction));
}

#[test]
fn public_signet_rejects_dev_wrong_genesis_and_missing_block_one() {
    for (genesis, block_one) in [
        (Network::Signet, Some(DEV_BLOCK_ONE)),
        (Network::Regtest, Some(PUBLIC_BLOCK_ONE)),
        (Network::Signet, None),
    ] {
        let (result, requests) = check_public_fixture(genesis, block_one, Some(PUBLIC_BLOCK_ONE));
        assert!(
            matches!(result, Err(Error::InvalidIndexer { .. })),
            "{result:?}"
        );
        assert_eq!(requests.first(), Some(&Request::ServerVersion));
        assert!(requests.contains(&Request::Genesis));
        assert!(!requests.contains(&Request::VerboseTransaction));
    }
}

#[test]
fn public_signet_rejects_a_dev_resolver_after_indexer_admission() {
    let (result, requests) =
        check_public_fixture(Network::Signet, Some(PUBLIC_BLOCK_ONE), Some(DEV_BLOCK_ONE));
    assert!(
        matches!(result, Err(Error::InvalidIndexer { .. })),
        "{result:?}"
    );
    assert_eq!(
        requests.iter().filter(|r| **r == Request::BlockOne).count(),
        2
    );
}

#[test]
fn dev_signet_rejects_plaintext_before_connecting() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("tcp://{}", listener.local_addr().unwrap());
    let result = check_indexer_config(
        &IndexerConfig::DevSignetElectrum { url },
        BitcoinNetwork::Signet,
    );
    assert!(
        matches!(result, Err(Error::InvalidIndexer { .. })),
        "{result:?}"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}
