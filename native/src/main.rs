// SPDX-License-Identifier: Apache-2.0
//! Local JSON-lines host for the on-chain RGB wallet. No TCP server or private signer.
mod engine;
mod profile;

const RUNTIME: &str = "node-host-process";

use engine::{MAX_FRAME, Worker, handle_request};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use zeroize::Zeroizing;

fn read_loop<R: BufRead, W: Write>(mut reader: R, mut writer: W) -> io::Result<()> {
    let mut worker = Worker::default();
    loop {
        // Read at most one bounded frame. Never log the frame; goOnline can carry credentials.
        let mut frame = Zeroizing::new(Vec::new());
        let count = reader
            .by_ref()
            .take(MAX_FRAME as u64 + 1)
            .read_until(b'\n', &mut frame)?;
        if count == 0 {
            return Ok(());
        }
        if count > MAX_FRAME || !frame.ends_with(b"\n") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid request frame",
            ));
        }
        serde_json::to_writer(&mut writer, &handle_request(&mut worker, &frame))?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

fn install_panic_hook() {
    // Upstream panic text may carry private storage or network context. Terminate the worker
    // rather than continuing from an uncertain side effect; expose a fixed diagnostic only.
    std::panic::set_hook(Box::new(|_| {
        eprintln!("RGB wallet worker terminated unexpectedly")
    }));
}

fn main() {
    install_panic_hook();
    unsafe {
        libc::umask(0o077);
    }
    if read_loop(
        BufReader::new(io::stdin().lock()),
        BufWriter::new(io::stdout().lock()),
    )
    .is_err()
    {
        std::process::exit(2);
    }
}
