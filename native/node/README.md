# Node native addon

The Node package loads `utexo-rgb-native.node` in a dedicated Node Worker. The
addon links the same Rust wallet engine as Bare, using the existing Node
`Cargo.lock`. Node-API version 8 provides the C ABI; it does not link V8 or require
a separate Rust process. Bare's addon and its build inputs remain independent.

`create()` returns an opaque, environment-bound handle. `request(handle, text)`
runs one bounded JSON request synchronously on the owning worker thread.
`destroy(handle)` releases the engine and its wallet lock, and is idempotent.
The addon does not accept keys or seeds. Signing stays in the package's JS
signer. The native request IDs, wallet identity, storage layout, operation
journals and recovery rules are unchanged.

The package owns dispatch and shutdown. It must stop admitting requests, await
any dispatched operation, then destroy the handle and wait for worker exit.
A JS timeout does not cancel native work. Do not terminate a worker to retry a
send or burn: the original operation may already have committed. Its journal
must be inspected after the original operation finishes.

Environment cleanup releases retained handles when a worker exits. The addon
image remains mapped because rgb-lib's process-wide Tokio runtime can outlive
a wallet. This is code residency, not retention of wallet locks. The addon does
not change the application's umask or install a process-wide panic hook.
Uncaught process aborts and upstream process-wide resources have the same
in-process limitations as Bare; a thread is not a subprocess crash boundary.
Upstream may register process-wide logging and panic hooks. Native code shares
the host's OS environment and file descriptors, even when the JS worker has a
restricted environment. Fixed API errors do not promise redaction of every
upstream diagnostic written to the process's standard error.

## Build and check

Use Rust 1.94.0 and a supported Node installation including its headers:

```sh
native/node/build.sh darwin-arm64 "$PWD/native/target/node-addon/utexo-rgb-native.node"
node native/node/smoke.cjs "$PWD/native/target/node-addon/utexo-rgb-native.node"
cargo +1.94.0 test --manifest-path native/Cargo.toml --release --lib --tests --locked
```

The other native host targets are `darwin-x64`, `linux-arm64-gnu`,
`linux-x64-gnu` and `linux-x64-musl`. Build and execute on the matching host.
`NODE_INCLUDE_DIR` can point to the installed Node headers; Alpine packages
typically use `/usr/include/node`. The build verifies upstream sources and
exports only the two Node-API registration symbols. Shared-library hashes,
platform ABI and package/native identity must also pass package admission.
