// SPDX-License-Identifier: Apache-2.0
use electrum_client::bitcoin::{
    Network,
    block::Header,
    consensus::encode::{deserialize_hex, serialize_hex},
    constants::genesis_block,
};
use electrum_client::{Batch, Client, ConfigBuilder, ElectrumApi, Param};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const PUBLIC_BLOCK_ONE: &str = "00000020f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000f575c83235984e7dc4afc1f30944c170462e84437ab6f2d52e16878a79e4678bd1914d5fae77031eccf40700";
const DEV_BLOCK_ONE: &str = "00000020f61eee3b63a380a477a063af32b2bbc97c9ff9f01f2c4225e973988108000000ff4f693674163783e85d4c1c57205c20804084d70447bd224cf95f8c08510f00fe1c8069ae77031e22260200";

struct ElectrumFixture {
    url: String,
    server: JoinHandle<()>,
}

impl ElectrumFixture {
    fn start(script: impl FnOnce(TcpListener) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("tcp://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || script(listener));
        Self { url, server }
    }

    fn client(&self) -> Result<Client, electrum_client::Error> {
        let genesis = genesis_block(Network::Signet).header.block_hash();
        let block_one = deserialize_hex::<Header>(PUBLIC_BLOCK_ONE)
            .unwrap()
            .block_hash();
        Client::from_config(
            &self.url,
            ConfigBuilder::new()
                .timeout(Some(Duration::from_secs(2)))
                .retry(0)
                .chain_checkpoints(vec![(0, genesis), (1, block_one)])
                .build(),
        )
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
                Err(error) => panic!("Fixture did not receive its next connection: {error}"),
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
        connection.reply(&handshake, json!(["checkpoint-fixture", "1.6"]));
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
        let reply = json!({"jsonrpc":"2.0", "id":request["id"], "result":result});
        writeln!(self.0.get_mut(), "{reply}").unwrap();
        self.0.get_mut().flush().unwrap();
    }

    fn checkpoint(&mut self, height: usize, header: &str) {
        let request = self.read("blockchain.block.header");
        assert_eq!(request["params"], json!([height]));
        self.reply(&request, json!(header));
    }

    fn public_signet(&mut self, block_one: &str) {
        let genesis = serialize_hex(&genesis_block(Network::Signet).header);
        self.checkpoint(0, &genesis);
        self.checkpoint(1, block_one);
    }

    fn reply_tip(&mut self) {
        let read = self.read("blockchain.headers.subscribe");
        self.reply(&read, json!({"height":1, "hex":PUBLIC_BLOCK_ONE}));
    }

    fn reply_ping(&mut self) {
        let ping = self.read("server.ping");
        self.reply(&ping, Value::Null);
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
fn eligible_read_reconnects_and_rechecks_every_checkpoint_on_the_replacement_socket() {
    let fixture = ElectrumFixture::start(|listener| {
        let mut original = Connection::accept(&listener);
        original.public_signet(PUBLIC_BLOCK_ONE);
        original.read("blockchain.headers.subscribe");
        original.close();

        let mut replacement = Connection::accept(&listener);
        replacement.public_signet(PUBLIC_BLOCK_ONE);
        replacement.reply_tip();
        replacement.assert_eof();
    });
    let client = fixture.client().unwrap();
    let tip = client.block_headers_subscribe().unwrap();
    assert_eq!(tip.height, 1);
    assert_eq!(
        tip.header,
        deserialize_hex::<Header>(PUBLIC_BLOCK_ONE).unwrap()
    );
    drop(client);
    fixture.finish();
}

#[test]
fn wrong_genesis_is_rejected_before_initial_client_admission() {
    let fixture = ElectrumFixture::start(|listener| {
        let mut wrong = Connection::accept(&listener);
        wrong.checkpoint(0, &serialize_hex(&genesis_block(Network::Regtest).header));
        wrong.assert_eof();
    });
    assert!(fixture.client().is_err());
    fixture.finish();
}

#[test]
fn replacement_on_another_signet_is_rejected_before_retrying_the_read() {
    let fixture = ElectrumFixture::start(|listener| {
        let mut original = Connection::accept(&listener);
        original.public_signet(PUBLIC_BLOCK_ONE);
        original.read("blockchain.headers.subscribe");
        original.close();

        let mut wrong = Connection::accept(&listener);
        wrong.public_signet(DEV_BLOCK_ONE);
        wrong.assert_eof();
    });
    let client = fixture.client().unwrap();
    assert!(client.block_headers_subscribe().is_err());
    drop(client);
    fixture.finish();
}

#[derive(Clone, Copy, Debug)]
enum NonReplayable {
    Broadcast,
    BroadcastPackage,
    RawBroadcast,
    UnknownRaw,
    MixedBatch,
}

impl NonReplayable {
    fn invoke(self, client: &Client) -> bool {
        match self {
            Self::Broadcast => client.transaction_broadcast_raw(&[0xab]).is_err(),
            Self::BroadcastPackage => client
                .transaction_broadcast_package_raw(&[&[0xab]])
                .is_err(),
            Self::RawBroadcast => client
                .raw_call(
                    "blockchain.transaction.broadcast",
                    [Param::String("ab".into())],
                )
                .is_err(),
            Self::UnknownRaw => client
                .raw_call("server.experimental_mutation", [Param::String("ab".into())])
                .is_err(),
            Self::MixedBatch => {
                let mut batch = Batch::default();
                batch.block_header(2);
                batch.raw(
                    "blockchain.transaction.broadcast".into(),
                    vec![Param::String("ab".into())],
                );
                client.batch_call(&batch).is_err()
            }
        }
    }

    fn receive_once(self, connection: &mut Connection) {
        match self {
            Self::MixedBatch => {
                let read = connection.read("blockchain.block.header");
                assert_eq!(read["params"], json!([2]));
                let write = connection.read("blockchain.transaction.broadcast");
                assert_eq!(write["params"], json!(["ab"]));
            }
            Self::Broadcast | Self::RawBroadcast => {
                let write = connection.read("blockchain.transaction.broadcast");
                assert_eq!(write["params"], json!(["ab"]));
            }
            Self::BroadcastPackage => {
                let write = connection.read("blockchain.transaction.broadcast_package");
                assert_eq!(write["params"], json!([["ab"]]));
            }
            Self::UnknownRaw => {
                let write = connection.read("server.experimental_mutation");
                assert_eq!(write["params"], json!(["ab"]));
            }
        }
    }
}

#[test]
fn writes_unknown_raw_calls_and_mixed_batches_are_never_replayed() {
    for call in [
        NonReplayable::Broadcast,
        NonReplayable::BroadcastPackage,
        NonReplayable::RawBroadcast,
        NonReplayable::UnknownRaw,
        NonReplayable::MixedBatch,
    ] {
        let fixture = ElectrumFixture::start(move |listener| {
            let mut original = Connection::accept(&listener);
            original.public_signet(PUBLIC_BLOCK_ONE);
            original.reply_ping();
            call.receive_once(&mut original);
            // Receive the complete operation, then drop the response to model an
            // ambiguous result where resending would be unsafe.
            original.close();

            let mut replacement = Connection::accept(&listener);
            replacement.public_signet(PUBLIC_BLOCK_ONE);
            // Only the caller's subsequent read may run on this socket.
            replacement.reply_tip();
            replacement.assert_eof();
        });
        let client = fixture.client().unwrap();
        assert!(
            call.invoke(&client),
            "lost result must remain an error for {call:?}"
        );
        assert_eq!(
            client.block_headers_subscribe().unwrap().height,
            1,
            "next read after {call:?}"
        );
        drop(client);
        fixture.finish();
    }
}

#[test]
fn dead_socket_is_replaced_before_the_first_transmission_of_a_broadcast() {
    const BROADCAST_ID: &str = "0000000000000000000000000000000000000000000000000000000000000012";
    let fixture = ElectrumFixture::start(|listener| {
        let mut original = Connection::accept(&listener);
        original.public_signet(PUBLIC_BLOCK_ONE);
        original.read("server.ping");
        original.close();

        let mut replacement = Connection::accept(&listener);
        replacement.public_signet(PUBLIC_BLOCK_ONE);
        let broadcast = replacement.read("blockchain.transaction.broadcast");
        assert_eq!(broadcast["params"], json!(["ab"]));
        replacement.reply(&broadcast, json!(BROADCAST_ID));
        replacement.assert_eof();
    });
    let client = fixture.client().unwrap();
    assert_eq!(
        client
            .transaction_broadcast_raw(&[0xab])
            .unwrap()
            .to_string(),
        BROADCAST_ID
    );
    drop(client);
    fixture.finish();
}

#[test]
fn eligible_raw_read_and_read_only_batch_retry_after_checked_replacement() {
    const TXID: &str = "8153034f45e695453250a8fb7225a5e545144071d8ed7b0d3211efa1f3c92ad8";
    for batch_read in [false, true] {
        let fixture = ElectrumFixture::start(move |listener| {
            let mut original = Connection::accept(&listener);
            original.public_signet(PUBLIC_BLOCK_ONE);
            let initial = original.read("blockchain.transaction.get");
            assert_eq!(initial["params"], json!([TXID, true]));
            if batch_read {
                let header = original.read("blockchain.block.header");
                assert_eq!(header["params"], json!([2]));
            }
            original.close();

            let mut replacement = Connection::accept(&listener);
            replacement.public_signet(PUBLIC_BLOCK_ONE);
            let replay = replacement.read("blockchain.transaction.get");
            assert_eq!(replay["params"], initial["params"]);
            replacement.reply(&replay, json!({"hex":"00", "confirmations":1}));
            if batch_read {
                replacement.checkpoint(2, PUBLIC_BLOCK_ONE);
            }
            replacement.assert_eof();
        });
        let client = fixture.client().unwrap();
        let params = vec![Param::String(TXID.into()), Param::Bool(true)];
        let tx = if batch_read {
            let mut batch = Batch::default();
            batch.raw("blockchain.transaction.get".into(), params);
            batch.block_header(2);
            let mut result = client.batch_call(&batch).unwrap();
            assert_eq!(result.pop().unwrap(), PUBLIC_BLOCK_ONE);
            assert_eq!(result.len(), 1);
            result.pop().unwrap()
        } else {
            client
                .raw_call("blockchain.transaction.get", params)
                .unwrap()
        };
        assert_eq!(tx, json!({"hex":"00", "confirmations":1}));
        drop(client);
        fixture.finish();
    }
}

#[test]
fn retry_budget_is_one_socket_per_read() {
    let (done, wait_done) = std::sync::mpsc::channel();
    let fixture = ElectrumFixture::start(move |listener| {
        for _ in 0..2 {
            let mut connection = Connection::accept(&listener);
            connection.public_signet(PUBLIC_BLOCK_ONE);
            connection.read("blockchain.headers.subscribe");
            connection.close();
        }
        while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
            wait_done.recv_timeout(Duration::from_millis(2))
        {
            match listener.accept() {
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                result => panic!("the same read exceeded its reconnect budget: {result:?}"),
            }
        }
    });
    let client = fixture.client().unwrap();
    assert!(client.block_headers_subscribe().is_err());
    drop(client);
    done.send(()).unwrap();
    fixture.finish();
}
