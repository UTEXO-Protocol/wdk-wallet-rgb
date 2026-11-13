// SPDX-License-Identifier: Apache-2.0
//! Qualify unmodified Electrum retry behavior. Stock may retransmit an identical
//! transaction; the WDK journal prevents constructing a second transfer. WDK
//! chain preflights run at operation boundaries, not inside these reconnects.
use electrum_client::{Client, ConfigBuilder, ElectrumApi, Param};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const TXID: &str = "0000000000000000000000000000000000000000000000000000000000000012";

struct Fixture {
    url: String,
    server: JoinHandle<()>,
}

impl Fixture {
    fn start(script: impl FnOnce(TcpListener) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("tcp://{}", listener.local_addr().unwrap());
        Self {
            url,
            server: thread::spawn(move || script(listener)),
        }
    }

    fn client(&self, retries: u8) -> Client {
        Client::from_config(
            &self.url,
            ConfigBuilder::new()
                .timeout(Some(Duration::from_secs(2)))
                .retry(retries)
                .build(),
        )
        .unwrap()
    }

    fn finish(self) {
        self.server.join().unwrap();
    }
}

struct Connection(BufReader<TcpStream>);
impl Connection {
    fn accept(listener: &TcpListener) -> Self {
        let deadline = Instant::now() + Duration::from_secs(8);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("fixture missing connection: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut connection = Self(BufReader::new(stream));
        let handshake = connection.read("server.version");
        connection.reply(&handshake, json!(["stock-electrum-fixture", "1.6"]));
        connection
    }

    fn read(&mut self, method: &str) -> Value {
        let mut line = String::new();
        assert_ne!(self.0.read_line(&mut line).unwrap(), 0, "expected {method}");
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], method, "unexpected RPC {request}");
        request
    }

    fn reply(&mut self, request: &Value, result: Value) {
        writeln!(
            self.0.get_mut(),
            "{}",
            json!({"jsonrpc":"2.0", "id":request["id"], "result":result})
        )
        .unwrap();
        self.0.get_mut().flush().unwrap();
    }

    fn close(self) {
        self.0.get_ref().shutdown(Shutdown::Both).unwrap();
    }

    fn assert_eof(&mut self) {
        let mut unexpected = String::new();
        assert_eq!(
            self.0.read_line(&mut unexpected).unwrap(),
            0,
            "unexpected RPC: {unexpected}"
        );
    }
}

#[test]
fn stock_read_reconnects_after_idle_socket_loss() {
    let fixture = Fixture::start(|listener| {
        let mut original = Connection::accept(&listener);
        let read = original.read("blockchain.transaction.get");
        assert_eq!(read["params"], json!([TXID, true]));
        original.close();
        let mut replacement = Connection::accept(&listener);
        let retried = replacement.read("blockchain.transaction.get");
        assert_eq!(retried["params"], read["params"]);
        replacement.reply(&retried, json!({"hex":"00", "confirmations":1}));
        replacement.assert_eof();
    });
    let client = fixture.client(1);
    let result = client
        .raw_call(
            "blockchain.transaction.get",
            [Param::String(TXID.into()), Param::Bool(true)],
        )
        .unwrap();
    assert_eq!(result["confirmations"], 1);
    drop(client);
    fixture.finish();
}

#[test]
fn lost_broadcast_response_can_only_retransmit_identical_transaction_bytes() {
    let fixture = Fixture::start(|listener| {
        let mut original = Connection::accept(&listener);
        let broadcast = original.read("blockchain.transaction.broadcast");
        assert_eq!(broadcast["params"], json!(["abcdef"]));
        original.close();
        let mut replacement = Connection::accept(&listener);
        let retried = replacement.read("blockchain.transaction.broadcast");
        assert_eq!(retried["params"], broadcast["params"]);
        replacement.reply(&retried, json!(TXID));
        replacement.assert_eof();
    });
    let client = fixture.client(1);
    assert_eq!(
        client
            .transaction_broadcast_raw(&[0xab, 0xcd, 0xef])
            .unwrap()
            .to_string(),
        TXID
    );
    drop(client);
    fixture.finish();
}

#[test]
fn read_retry_budget_remains_bounded() {
    let fixture = Fixture::start(|listener| {
        for _ in 0..2 {
            let mut connection = Connection::accept(&listener);
            connection.read("server.ping");
            connection.close();
        }
    });
    let client = fixture.client(1);
    assert!(client.ping().is_err());
    drop(client);
    fixture.finish();
}
