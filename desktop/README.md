# Whatfast desktop

## Release profile

The checked-in release profile uses thin LTO, one codegen unit, and symbol
stripping. On Linux x86-64 with Rust 1.88, the desktop executable measured
48,071,728 bytes before tuning and 33,077,136 bytes after the integrated issue
fixes (31.2% smaller).
Re-run `cargo build --release` and record the result when changing these
settings; binary size alone is not a reason to use `panic = "abort"`, which
would remove unwinding and reduce crash diagnostics.

Run the deterministic UI/performance fixture:

```sh
cargo run -- --fake-backend
```

Run against the real Go sidecar by placing `whatfast-backend` beside the
desktop binary or setting `WHATFAST_BACKEND=/absolute/path/to/whatfast-backend`.
Application data defaults to the platform user-data directory and can be
redirected with `WHATFAST_DATA_DIR`.

The fake backend exposes 10,000 chats and paged variable-height messages. Set
`WHATFAST_FAKE_PAIRING=1` to exercise QR pairing.
