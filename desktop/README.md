# Whatfast desktop

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
