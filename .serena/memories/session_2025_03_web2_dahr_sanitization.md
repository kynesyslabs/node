# Session – Web2/DAHR Sanitization
- Added shared helper `src/features/web2/sanitizeWeb2Request.ts` to strip or redact sensitive Web2 headers.
- Updated `handleWeb2.ts` logging to reuse sanitized copy of the request, preventing Authorization/Cookie leakage.
- `DAHR.toSerializable()` now uses the storage sanitizer so serialized transactions omit sensitive headers.
- TypeScript build still fails due to pre-existing repo issues (missing SDK helpers, Solana typings, etc.).