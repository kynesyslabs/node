# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
#
# Reproducible build of the TLSNotary verifier wasm. Run through build.sh.
# Everything that can change the output is pinned: the base image by digest,
# the C toolchain by exact Debian version, the Rust crates by Cargo.lock
# (--locked), tlsn by git rev, and the source paths (fixed in this image and
# remapped in .cargo/config.toml).

# rust:1.87.0-bookworm (multi-arch index). 1.87.0 is the tlsn alpha.12 CI
# toolchain. Bump the tag and digest together.
FROM --platform=linux/amd64 rust:1.87.0-bookworm@sha256:251cec8da4689d180f124ef00024c2f83f79d9bf984e43c180a598119e326b84 AS toolchain

# ring compiles C for wasm32. The packages come from a dated Debian snapshot
# at an exact version, so the same clang stays installable after the live
# mirror moves on.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20251101T000000Z bookworm main" > /etc/apt/sources.list \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get install -y --no-install-recommends clang-14=1:14.0.6-12 llvm-14=1:14.0.6-12 \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown

WORKDIR /tlsn-verify
COPY . .
RUN cargo fetch --locked

FROM toolchain AS build
RUN cargo build --locked --release --target wasm32-unknown-unknown --lib \
 && cp target/wasm32-unknown-unknown/release/demos_tlsn_verify.wasm /demos_tlsn_verify.wasm

# Export-only stages: build.sh copies their files out and never runs them.
# A non-root user anyway, so a stray `docker run` of one is not root.
FROM scratch AS wasm
COPY --from=build /demos_tlsn_verify.wasm /
USER 65534

# Native twin over the golden vectors: the cross-engine oracle (spike F2).
# The vectors come in as the named build context `vectors`.
FROM toolchain AS parity-run
RUN cargo build --locked --release --bin tlsn-verify-native
COPY --from=vectors . /vectors
RUN mkdir /native-out \
 && for d in /vectors/*/; do \
      n=$(basename "$d"); \
      [ -f "$d/presentation.bin" ] || continue; \
      root=$(sed -n 's/.*"root": *"\([^"]*\)".*/\1/p' "$d/meta.json"); \
      set -- "$d/presentation.bin"; \
      [ -n "$root" ] && set -- "$@" "/vectors/$root"; \
      target/release/tlsn-verify-native "$@" > "/native-out/$n.json" 2>/dev/null \
        || echo '{"ok":false,"error":"native process aborted"}' > "/native-out/$n.json"; \
    done

FROM scratch AS parity
COPY --from=parity-run /native-out/ /
USER 65534
