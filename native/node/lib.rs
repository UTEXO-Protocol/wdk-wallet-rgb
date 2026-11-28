// SPDX-License-Identifier: Apache-2.0
//! Node-API's synchronous Rust boundary. JavaScript owns a dedicated worker thread.
#[path = "../src/engine.rs"]
mod engine;
#[path = "../src/profile.rs"]
mod profile;

const RUNTIME: &str = "node-in-process";

use engine::{MAX_FRAME, Worker, handle_request};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

pub struct Handle {
    worker: Option<Worker>,
}

#[repr(C)]
pub struct Buffer {
    data: *mut u8,
    len: usize,
}

impl Buffer {
    const EMPTY: Self = Self {
        data: ptr::null_mut(),
        len: 0,
    };

    fn from_vec(bytes: Vec<u8>) -> Self {
        let bytes = bytes.into_boxed_slice();
        let len = bytes.len();
        let data = Box::into_raw(bytes).cast::<u8>();
        Self { data, len }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn utexo_node_create() -> *mut Handle {
    Box::into_raw(Box::new(Handle {
        worker: Some(Worker::default()),
    }))
}

/// The owning Node environment calls this serially while the handle is live.
///
/// # Safety
/// Both pointers must be valid for this call. The request points to `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_node_request(
    handle: *mut Handle,
    frame: *const u8,
    len: usize,
) -> Buffer {
    if frame.is_null() || len == 0 || len > MAX_FRAME {
        return Buffer::EMPTY;
    }
    let Some(handle) = (unsafe { handle.as_mut() }) else {
        return Buffer::EMPTY;
    };
    let frame = unsafe { std::slice::from_raw_parts(frame, len) };
    respond(handle, |worker| {
        serde_json::to_vec(&handle_request(worker, frame))
    })
}

fn respond(
    handle: &mut Handle,
    dispatch: impl FnOnce(&mut Worker) -> serde_json::Result<Vec<u8>>,
) -> Buffer {
    let Some(worker) = handle.worker.as_mut() else {
        return Buffer::EMPTY;
    };
    let response = catch_unwind(AssertUnwindSafe(|| dispatch(worker)));
    match response {
        Ok(Ok(bytes)) => Buffer::from_vec(bytes),
        _ => {
            // Never dispatch another mutation after a panic. The operation may
            // already be durable; reopening must consult the existing journal.
            let _ = catch_unwind(AssertUnwindSafe(|| drop(handle.worker.take())));
            Buffer::EMPTY
        }
    }
}

/// # Safety
/// Only buffers returned by this ABI may be released, at most once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_node_free(buffer: Buffer) {
    if !buffer.data.is_null() {
        unsafe {
            drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                buffer.data,
                buffer.len,
            )));
        }
    }
}

/// # Safety
/// Only a live handle returned by `utexo_node_create` may be destroyed, at most once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_node_destroy(handle: *mut Handle) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe { drop(Box::from_raw(handle)) }));
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn invalid_frames_and_null_handles_are_rejected() {
        unsafe {
            let handle = utexo_node_create();
            assert!(utexo_node_request(handle, ptr::null(), 1).data.is_null());
            assert!(utexo_node_request(handle, b"x".as_ptr(), 0).data.is_null());
            assert!(
                utexo_node_request(handle, b"x".as_ptr(), MAX_FRAME + 1)
                    .data
                    .is_null()
            );
            assert!(
                utexo_node_request(ptr::null_mut(), b"{}".as_ptr(), 2)
                    .data
                    .is_null()
            );
            utexo_node_destroy(handle);
            utexo_node_destroy(ptr::null_mut());
            utexo_node_free(Buffer::EMPTY);
        }
    }

    #[test]
    fn bounded_json_response_preserves_identity() {
        unsafe {
            let handle = utexo_node_create();
            let input = br#"{"id":"node-boundary","method":"version","params":{}}"#;
            let output = utexo_node_request(handle, input.as_ptr(), input.len());
            assert!(!output.data.is_null());
            let response: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(output.data, output.len))
                    .unwrap();
            assert_eq!(response["id"], "node-boundary");
            assert_eq!(response["result"]["runtime"], "node-in-process");
            utexo_node_free(output);
            utexo_node_destroy(handle);
        }
    }

    #[test]
    fn panic_retires_handle_and_releases_wallet_ownership() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let open = serde_json::to_vec(&serde_json::json!({
            "id": "panic-boundary", "method": "open", "params": {
                "network": "regtest", "dataDir": directory.path(),
                "accountXpubVanilla": "tpubDCXivb31ZeAsURzdKmZFmQKXAixbGF1SxmiLJNWKEbbDzwHZvKmdVszKcMEZsFpuBZ5xTM732FVkT1JWVqLZMV84zi3cMwRD8kELPJBQy5e",
                "accountXpubColored": "tpubDCnYdtmvqfaj4msxcfMRVdNdnrKNJ8e27QxkJNnG4ZqJXYWxxWvHwnV2gvXjiXt3P4yKQJkwXmvwSK146zF3ZNog46HpKZbzWyxGKfZhD12",
                "masterFingerprint": "4a1c8d2c"
            }
        })).unwrap();
        unsafe {
            let first = utexo_node_create();
            let opened = utexo_node_request(first, open.as_ptr(), open.len());
            assert!(!opened.data.is_null());
            let value: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(opened.data, opened.len))
                    .unwrap();
            assert_eq!(value["result"]["watchOnly"], true);
            utexo_node_free(opened);
            assert!(
                respond(&mut *first, |_| panic!("boundary fixture"))
                    .data
                    .is_null()
            );
            assert!((*first).worker.is_none());
            // Retirement is terminal even though the opaque wrapper remains alive.
            assert!(
                utexo_node_request(first, open.as_ptr(), open.len())
                    .data
                    .is_null()
            );
            let second = utexo_node_create();
            let reopened = utexo_node_request(second, open.as_ptr(), open.len());
            assert!(!reopened.data.is_null());
            let value: serde_json::Value =
                serde_json::from_slice(std::slice::from_raw_parts(reopened.data, reopened.len))
                    .unwrap();
            assert_eq!(value["result"]["watchOnly"], true);
            utexo_node_free(reopened);
            utexo_node_destroy(first);
            utexo_node_destroy(second);
        }
    }
}
