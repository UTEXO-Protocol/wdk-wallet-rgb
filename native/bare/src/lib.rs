// SPDX-License-Identifier: Apache-2.0
//! C ABI for the synchronous Bare addon. The JS package owns a dedicated worker thread.
#[path = "../../src/engine.rs"]
mod engine;
#[path = "../../src/profile.rs"]
mod profile;

const RUNTIME: &str = "bare-in-process";

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
pub extern "C" fn utexo_onchain_create() -> *mut Handle {
    Box::into_raw(Box::new(Handle {
        worker: Some(Worker::default()),
    }))
}

/// Called serially by the owning JS environment while the handle is live.
///
/// # Safety
/// Both pointers must be valid for this call. The request points to `len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_onchain_request(
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
    let Some(worker) = handle.worker.as_mut() else {
        return Buffer::EMPTY;
    };
    let frame = unsafe { std::slice::from_raw_parts(frame, len) };
    let response = catch_unwind(AssertUnwindSafe(|| {
        serde_json::to_vec(&handle_request(worker, frame))
    }));
    match response {
        Ok(Ok(bytes)) => Buffer::from_vec(bytes),
        _ => {
            // A mutation may already have taken effect. Close this engine and let the
            // caller reopen with its durable operation journal before any further work.
            let _ = catch_unwind(AssertUnwindSafe(|| drop(handle.worker.take())));
            Buffer::EMPTY
        }
    }
}

/// # Safety
/// Only buffers returned by this ABI may be released, at most once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_onchain_free(buffer: Buffer) {
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
/// Only a live handle returned by `utexo_onchain_create` may be destroyed, at most once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn utexo_onchain_destroy(handle: *mut Handle) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe { drop(Box::from_raw(handle)) }));
    }
}
