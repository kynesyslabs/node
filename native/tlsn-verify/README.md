# tlsn-verify

A deterministic, verify-only TLSNotary presentation checker for the Demos node. It is built to `wasm32` and loaded by `src/libs/tlsnotary/wasmVerifier.ts`. The node runs it inside block apply, so every node must reach the same verdict and the same facts from the same bytes.

- Pinned to tlsn `v0.1.0-alpha.12` (commit `f2ff4ba7`), the same release as the tlsn-js prover and the notary image.
- Verify only. It reads presentation bytes and returns facts as JSON. It makes no policy decision: trusted keys, server, path, bind header and redaction rules are applied by the node, under its fork rules.
- No host surface. The module has **zero imports**: no clock, RNG, file system or network. `web-time` is replaced by a `std::time` shim (`shims/web-time`), so a wall-clock read traps. Both getrandom versions get a backend that always fails.
- The certificate chain is checked at the notary-attested connection time, never at wall-clock time. Roots come from the compiled-in webpki-roots set (`=0.26.11`, which re-exports `=1.0.0`). Changing the set means a new verifier.
- Memory is capped at 64 MiB (`--max-memory`). tlsn-core allocates an attacker-chosen size while decoding (spike F1). With the cap that allocation traps, the same way on every host. The loader treats a trap as a refusal.
- Input is capped at 1 MiB before decode. Decode is strict: no trailing bytes.

## Interface

Plain C-ABI exports, without wasm-bindgen:

| Export | Purpose |
|---|---|
| `tv_abi_version() -> u32` | `1`; the loader refuses any other value |
| `tv_max_input() -> usize` | the input cap (1 MiB) |
| `tv_alloc(len) -> ptr`, `tv_free(ptr, len)` | input buffers |
| `tv_verify(p_ptr, p_len, root_ptr, root_len) -> u32` | 1 = verified, 0 = refused; `root_len = 0` uses webpki-roots |
| `tv_out_ptr()`, `tv_out_len()` | the JSON result of the last call |

On success the output is (keys sorted, compact JSON):

```
ok, attestationId, attestationVersionIsCurrent, signatureAlg,
verifyingKey{alg,hex}, serverName, time, tlsVersion,
transcriptLength{sent,received}, sent, sentAuthed, recv, recvAuthed, extensions
```

- `attestationId` is the notary's random id in the signed header. Presentation bytes are malleable (F3), so replay and uniqueness checks must key on this id.
- `verifyingKey.alg` is `k256` (33-byte compressed) or `p256` (65-byte uncompressed, F0). Both are decoded; policy decides.
- `serverName` is `null` when the identity proof is omitted (F5).
- `sent`/`recv` are hex. Bytes outside `sentAuthed`/`recvAuthed` are zero.

On refusal the output is `{"ok":false,"error":...}`. The error text is for logs only: some tlsn messages depend on HashMap order (F4). The TS loader returns `{ ok: false }` with no reason and passes the text only to an optional log hook.

The loader separates a refusal from "no verdict":

- a wasm trap is a refusal, because it follows from the input alone;
- a host failure, such as instance or stack exhaustion, throws `TlsnVerifierUnavailableError`, because another node may verify the same bytes;
- a wasm that does not match the pin throws `TlsnVerifierLoadError`.

The pinned-root argument exists for local test vectors, whose server uses a test CA. In TS it is reachable only through `verifyWithTestRoot`; consensus code uses `verifyPresentation`.

## Build

Docker only; no Rust toolchain on the host. The image and the Dockerfile syntax are pinned by digest (`rust:1.87.0-bookworm`, the tlsn alpha.12 CI toolchain), clang/llvm 14 by exact version from a dated `snapshot.debian.org` source, crates by `Cargo.lock` (`--locked`) and tlsn by git rev. Sources sit at fixed paths in the image, and the paths are remapped (`.cargo/config.toml`), so the host checkout path does not reach the artifact.

```
./build.sh          # writes dist/demos_tlsn_verify.wasm and dist/demos_tlsn_verify.wasm.sha256
./build.sh check    # rebuilds and fails unless the result equals the committed wasm (CI)
./build.sh parity   # native twin over testing/tlsn-vectors; fails on any disagreement (CI)
```

`BUILDX_BUILDER=<name>` selects a buildx builder. For example, a `docker-container` builder created with `--driver-opt memory=6g` caps memory on a shared host. A cold build takes about 1.5 minutes.

After a rebuild, update `TLSN_VERIFY_WASM_SHA256` in `src/libs/tlsnotary/wasmVerifier.ts`. The loader refuses to load a wasm whose sha256 differs from that pin.

## Golden vectors

`testing/tlsn-vectors/<name>/` holds the following files:

- `presentation.bin`: the bincode bytes, the same as tlsn-js `presentation.data`;
- `meta.json`:
  - `verifier`: `ok` or `refused`;
  - `refusal` (refused vectors only): the reason class (`decode`, `verify` or `trap`) and a stable phase substring;
  - `root`: the pinned test root, or `null` for webpki-roots;
  - `nodePolicy`: the verdict the design's node policy gives. It is for W4 and is not checked here;
  - `expect`: the server, path and bind header the policy expects;
- `output.json` (accepted vectors only): the exact bytes the wasm emits.

`src/libs/tlsnotary/wasmVerifier.test.ts` requires every accepted vector to be byte-identical, and every refused one to be `{ ok: false }` for its stated reason. The vectors come from the W1a spike. All keys, the CA and the bind values are test-only, and Authorization values are absent: they are redacted, so the presentations do not carry them.

## Bumping tlsn or the root store

The verdict is consensus data. A new tlsn release, new roots or any change to the facts is therefore a new verifier, never an in-place update:

1. Add the new verifier beside this one, for example `native/tlsn-verify-v2/` with its own `dist/`, sha256 pin and vectors. Keep this crate, its wasm and its vectors unchanged, because replaying old blocks must use the verifier that was active at their height.
2. Select the verifier by fork activation height (the `tlsnVerified` fork payload). Blocks below the height use v1, and blocks at or above it use v2.
3. Bump the tlsn-js prover in the SDK and the notary image to the same release.
4. Run `./build.sh check` and `./build.sh parity` for both versions in CI.

## Known limits

- The `sent_total`/`recv_total` allocation (F1) is contained by the memory cap. It is not bounded before decode, because that needs a tlsn-core patch, which should be reported upstream.
- Native parity is checked on x86_64 only. The wasm itself is arch-independent.
- The build is pinned to `linux/amd64`. A builder on another arch emulates amd64.
