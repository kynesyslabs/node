//! Replaces web-time 0.2 so the wasm32 verifier does not pull wasm-bindgen
//! and js-sys. On wasm32-unknown-unknown `std::time::SystemTime::now()`
//! panics, so any wall-clock read in the verify path traps instead of
//! silently importing `performance.now`.
pub use std::time::*;
