// SPDX-License-Identifier: Apache-2.0
//! Stock BFA.8 supports Dev through the ordinary Esplora adapter. It checks the
//! Signet genesis; the WDK's separate network unit tests enforce Dev block one.
use rgb_lib::bitcoin::{Network, constants::genesis_block};
use rgb_lib::wallet::{IndexerProtocol, check_indexer_url};
use rgb_lib::{BitcoinNetwork, Error};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

fn stock_esplora(genesis_network: Network) -> (Result<IndexerProtocol, Error>, Vec<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let (stop, stopped) = mpsc::channel::<()>();
    let server = thread::spawn(move || {
        while let Err(mpsc::RecvTimeoutError::Timeout) =
            stopped.recv_timeout(Duration::from_millis(2))
        {
            let (stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == ErrorKind::WouldBlock => continue,
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            let mut request = line.split_whitespace();
            assert_eq!(request.next(), Some("GET"));
            let path = request.next().unwrap().to_owned();
            captured.lock().unwrap().push(path.clone());
            loop {
                line.clear();
                assert_ne!(stream.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
            }
            assert_eq!(path, "/block-height/0");
            let body = genesis_block(genesis_network).block_hash().to_string();
            write!(
                stream.get_mut(),
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    let result = check_indexer_url(&url, None, BitcoinNetwork::Signet);
    drop(stop);
    server.join().unwrap();
    let requests = Arc::try_unwrap(requests).unwrap().into_inner().unwrap();
    (result, requests)
}

#[test]
fn ordinary_esplora_admits_the_genesis_shared_by_public_and_dev_signet() {
    let (result, requests) = stock_esplora(Network::Signet);
    assert!(matches!(result, Ok(IndexerProtocol::Esplora)), "{result:?}");
    assert!(!requests.is_empty());
    assert!(requests.iter().all(|path| path == "/block-height/0"));
}

#[test]
fn ordinary_esplora_rejects_a_different_network_genesis() {
    let (result, _) = stock_esplora(Network::Regtest);
    assert!(
        matches!(result, Err(Error::InvalidIndexer { .. })),
        "{result:?}"
    );
}
