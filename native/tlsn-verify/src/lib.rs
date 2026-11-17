//! Verify-only TLSNotary presentation checker for the Demos node.
//!
//! Input: bincode bytes of a `tlsn_core::presentation::Presentation` at
//! v0.1.0-alpha.12 (the `data` hex field of a tlsn-js presentation JSON).
//! Output: one JSON object with the facts the node judges. This crate makes no
//! policy decision (trusted keys, server, path, bind header, redaction): the
//! node applies those under its fork rules, so the same facts can be judged
//! under different rules without a new verifier.
//!
//! Determinism: the certificate chain is checked at the notary-attested
//! connection time (`tlsn-core` hands `connection_info.time` to webpki), the
//! root store is the compiled-in webpki-roots set unless the caller pins one
//! test root, and the wasm build has no host imports at all, so it cannot read
//! a clock, randomness, files or the network.

use std::sync::Mutex;

use bincode::Options;
use serde_json::{json, Value};
use tls_core::{anchors::RootCertStore, key::Certificate, verify::WebPkiVerifier};
use tlsn_core::{
    presentation::{Presentation, PresentationOutput},
    transcript::Idx,
    CryptoProvider,
};

/// Version of the exported C ABI below. The host refuses a module that
/// reports another value, so a wasm swapped under the same path cannot be
/// driven with the wrong calling convention.
pub const ABI_VERSION: u32 = 1;

/// Hard cap on the serialized presentation, checked before decode. The node
/// may apply a smaller cap of its own.
pub const MAX_PRESENTATION_BYTES: usize = 1 << 20;

fn ranges(idx: &Idx) -> Value {
    Value::Array(idx.iter_ranges().map(|r| json!([r.start, r.end])).collect())
}

fn provider(pinned_root_der: Option<&[u8]>) -> Result<CryptoProvider, String> {
    match pinned_root_der {
        None => Ok(CryptoProvider::default()),
        Some(der) => {
            let mut store = RootCertStore::empty();
            store
                .add(&Certificate(der.to_vec()))
                .map_err(|e| format!("bad_pinned_root: {e}"))?;
            Ok(CryptoProvider {
                cert: WebPkiVerifier::new(store, None),
                ..Default::default()
            })
        }
    }
}

/// Verifies a serialized presentation and returns the facts as JSON.
///
/// `pinned_root_der`: `None` uses the compiled-in webpki-roots set; `Some`
/// replaces it with exactly one root (local test vectors only).
///
/// On refusal the object is `{"ok":false,"error":...}`. The error text is for
/// logs only: some tlsn messages depend on HashMap order, so it is not stable
/// between runs (spike F4).
pub fn verify_presentation(bytes: &[u8], pinned_root_der: Option<&[u8]>) -> Value {
    match verify_inner(bytes, pinned_root_der) {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

fn verify_inner(bytes: &[u8], pinned_root_der: Option<&[u8]>) -> Result<Value, String> {
    if bytes.len() > MAX_PRESENTATION_BYTES {
        return Err(format!("too_large: {} bytes", bytes.len()));
    }
    // Same encoding as `bincode::serialize` (fixint, little endian) but with a
    // read limit and no trailing bytes accepted.
    let presentation: Presentation = bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_limit(MAX_PRESENTATION_BYTES as u64)
        .reject_trailing_bytes()
        .deserialize(bytes)
        .map_err(|e| format!("decode: {e}"))?;

    let key = presentation.verifying_key().clone();
    let provider = provider(pinned_root_der)?;

    let PresentationOutput {
        attestation,
        server_name,
        connection_info,
        transcript,
        extensions,
        ..
    } = presentation
        .verify(&provider)
        .map_err(|e| format!("verify: {e}"))?;

    let tls_version = match connection_info.version {
        tlsn_core::connection::TlsVersion::V1_2 => "1.2",
        tlsn_core::connection::TlsVersion::V1_3 => "1.3",
    };

    // Bytes outside the authed ranges are zero-filled by tlsn-core; callers
    // must read only inside `sentAuthed` / `recvAuthed`.
    let (sent, sent_authed, recv, recv_authed) = match transcript.as_ref() {
        Some(t) => (
            Value::String(hex::encode(t.sent_unsafe())),
            ranges(t.sent_authed()),
            Value::String(hex::encode(t.received_unsafe())),
            ranges(t.received_authed()),
        ),
        None => (Value::Null, Value::Null, Value::Null, Value::Null),
    };

    Ok(json!({
        "ok": true,
        // Notary-chosen random id inside the signed header. Presentation bytes
        // are malleable (spike F3), so this, not their hash, is the replay and
        // uniqueness key.
        "attestationId": hex::encode(attestation.header.id.0),
        // The signed header carries Version(0) for every alpha release (spike
        // F6); the format itself is pinned by pinning this build.
        "attestationVersionIsCurrent": attestation.header.version == tlsn_core::attestation::VERSION,
        "signatureAlg": attestation.signature.alg.to_string(),
        // k256: 33-byte compressed; p256: 65-byte uncompressed (spike F0).
        "verifyingKey": {
            "alg": key.alg.to_string(),
            "hex": hex::encode(&key.data),
        },
        // Null when the presentation omits the identity proof, which tlsn
        // still accepts (spike F5); the node policy must refuse that.
        "serverName": server_name.map(|s| s.as_str().to_string()),
        "time": connection_info.time,
        "tlsVersion": tls_version,
        "transcriptLength": {
            "sent": connection_info.transcript_length.sent,
            "received": connection_info.transcript_length.received,
        },
        "sent": sent,
        "sentAuthed": sent_authed,
        "recv": recv,
        "recvAuthed": recv_authed,
        "extensions": extensions.len(),
    }))
}

// ---------------------------------------------------------------------------
// Plain C-ABI exports for wasm32: no wasm-bindgen, so the module has no host
// imports (spike F10).
// Protocol: tv_alloc -> copy input -> tv_verify -> read tv_out_ptr/tv_out_len.
// ---------------------------------------------------------------------------

static OUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static HOOK: std::sync::Once = std::sync::Once::new();

/// With panic=abort a panic traps the instance. The hook first leaves a
/// refusal JSON in OUT so the host can log why before it drops the instance.
fn install_panic_hook() {
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown".to_string()
            };
            let loc = info
                .location()
                .map(|l| format!(" at {}:{}", l.file(), l.line()))
                .unwrap_or_default();
            if let Ok(mut out) = OUT.try_lock() {
                *out = serde_json::to_vec(
                    &json!({ "ok": false, "error": format!("panic: {msg}{loc}") }),
                )
                .unwrap_or_default();
            }
        }));
    });
}

#[no_mangle]
pub extern "C" fn tv_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn tv_max_input() -> usize {
    MAX_PRESENTATION_BYTES
}

#[no_mangle]
pub extern "C" fn tv_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from `tv_alloc`.
#[no_mangle]
pub unsafe extern "C" fn tv_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Returns 1 when the presentation verified, 0 when it was refused. The JSON
/// result is readable through `tv_out_ptr`/`tv_out_len` until the next call.
///
/// # Safety
/// The pointers must reference `len` readable bytes (the root may be len 0).
#[no_mangle]
pub unsafe extern "C" fn tv_verify(
    p_ptr: *const u8,
    p_len: usize,
    r_ptr: *const u8,
    r_len: usize,
) -> u32 {
    install_panic_hook();
    // Pre-filled so a trap without a panic message (allocation failure under
    // the memory cap) still leaves a refusal for the host to log.
    if let Ok(mut out) = OUT.lock() {
        *out = br#"{"error":"trap: aborted without panic message (allocation failure)","ok":false}"#.to_vec();
    }
    let pres = std::slice::from_raw_parts(p_ptr, p_len);
    let root = if r_len == 0 {
        None
    } else {
        Some(std::slice::from_raw_parts(r_ptr, r_len))
    };
    let v = verify_presentation(pres, root);
    let ok = v.get("ok").and_then(Value::as_bool) == Some(true);
    let mut out = OUT.lock().unwrap();
    *out = serde_json::to_vec(&v).unwrap();
    ok as u32
}

#[no_mangle]
pub extern "C" fn tv_out_ptr() -> *const u8 {
    OUT.lock().unwrap().as_ptr()
}

#[no_mangle]
pub extern "C" fn tv_out_len() -> usize {
    OUT.lock().unwrap().len()
}

// Any use of randomness in the verify path fails instead of importing a host
// RNG.
#[cfg(target_arch = "wasm32")]
mod no_rng {
    fn fail02(_: &mut [u8]) -> Result<(), getrandom02::Error> {
        Err(getrandom02::Error::UNSUPPORTED)
    }
    getrandom02::register_custom_getrandom!(fail02);

    #[no_mangle]
    unsafe extern "Rust" fn __getrandom_v03_custom(
        _dest: *mut u8,
        _len: usize,
    ) -> Result<(), getrandom03::Error> {
        Err(getrandom03::Error::UNSUPPORTED)
    }
}
