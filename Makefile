.PHONY: check test build backend desktop release fake clean

check:
	cd backend && go test ./...
	cd desktop && cargo check --tests

test:
	cd backend && go test ./...
	cd desktop && cargo test

build: backend desktop

backend:
	mkdir -p build
	cd backend && go build -o ../build/whatfast-backend ./cmd/whatfast-backend

desktop: backend
	cd desktop && cargo build
	cp build/whatfast-backend desktop/target/debug/whatfast-backend

release:
	mkdir -p build desktop/target/release
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../build/whatfast-backend ./cmd/whatfast-backend
	cd desktop && cargo build --release --locked
	cp build/whatfast-backend desktop/target/release/whatfast-backend

fake:
	cd desktop && cargo run -- --fake-backend

clean:
	cd backend && go clean
	cd desktop && cargo clean
