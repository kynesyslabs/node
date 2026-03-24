# TLSN + OAuth Web2 Identity Flow

This document describes the current integrated flow for adding Web2 identities (`github`, `discord`, `telegram`) via TLSNotary.

It reflects the behavior implemented in:
- `src/libs/tlsnotary/verifier.ts`
- `src/libs/network/routines/transactions/handleIdentityRequest.ts`
- `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`
- SDK payload contracts from `@kynesyslabs/demosdk` (`InferFromTLSNPayload`, `addWeb2IdentityViaTLSN`)

## 1. End-to-End Flow

```text
CLIENT (Incentives / Wallet / SDK)
OAuth token acquired
  -> TLSN attest target API
  -> get transcript (sent/recv)
  -> select disclosed recv bytes (revealedRecv)
  -> compute recvHash = sha256(revealedRecv)
  -> build tlsn_identity_assign payload
  -> send tx via addWeb2IdentityViaTLSN

NODE
handleIdentityRequest
  -> verifyTLSNProof
     -> validate proof structure
        if fail: REJECT
     -> validate recvHash format (64 hex chars)
        if fail: REJECT
     -> validate sha256(revealedRecv) == recvHash
        if fail: REJECT
     -> parse HTTP body from revealedRecv
     -> extract username/userId by context
     -> compare extracted fields with claimed fields
        if mismatch: REJECT
  -> applyTLSNIdentityAdd
  -> store identity + proofHash + incentives
```

## 2. Payload Contract (`tlsn_identity_assign`)

Current payload expected by node verification (`TLSNIdentityPayload`):

```ts
{
  context: "github" | "discord" | "telegram",
  proof: {
    version: string,
    data: string, // hex proof blob
    meta: {
      notaryUrl?: string,
      websocketProxyUrl?: string
    }
  },
  recvHash: string,      // 64-char hex sha256 of revealedRecv bytes
  proofRanges: {
    recv: Array<{ start: number; end: number }>,
    sent: Array<{ start: number; end: number }>
  },
  revealedRecv: number[], // disclosed recv bytes used for extraction and hash check
  username: string,
  userId: string,
  referralCode?: string
}
```

Notes:
- `recvHash` must be lowercase/uppercase hex without `0x` prefix (exactly 64 hex chars).
- `revealedRecv` is currently required for strict verification on node.
- `proofRanges` is carried in payload for compatibility/audit metadata, but strict extraction uses `revealedRecv`.

## 3. What Node Verifies

Node-side verification (`verifyTLSNProof`) performs:

1. Context validation (`github` / `discord` / `telegram`).
2. `recvHash` format validation (`^[0-9a-fA-F]{64}$`).
3. TLSN presentation structure validation (`proof.version`, `proof.data` hex, min length).
4. `revealedRecv` byte-array validation (`0..255`, non-empty).
5. Integrity check: `sha256(revealedRecv)` must equal payload `recvHash`.
6. HTTP/body parsing from `revealedRecv`.
7. Context-specific identity extraction:
   - GitHub: `login`, `id`
   - Discord: `username`, `id`
   - Telegram: `user.username` or `first_name`, and `id`
8. Equality check vs claimed payload fields:
   - extracted `username` === claimed `username`
   - extracted `userId` === claimed `userId`

If any step fails, transaction is rejected.

## 4. What Happens After Verification

If verification succeeds:

1. `GCRIdentityRoutines.applyTLSNIdentityAdd` ensures identity does not already exist for same `userId` in context.
2. Identity is persisted under `identities.web2[context]` with:
   - `userId`
   - `username`
   - `proof` (presentation)
   - `proofHash = sha256(JSON.stringify(proof))`
   - `proofType = "tlsn"`
   - `timestamp`
3. Incentive awarding path runs for first-time link per context.

## 5. Current Trust Model and Limits

Important:
- Node currently does **structure validation** for TLSN proof objects.
- Node does **consistency validation** between claimed identity and disclosed transcript bytes.
- Node does **not** perform full TLSN cryptographic attestation verification of canonical transcript in this path.

So the current model is:
- Strong binding between `recvHash`, `revealedRecv`, and extracted identity fields.
- Not equivalent to full backend cryptographic verification of proof internals.

## 6. Integration Checklist (Incentives / Wallet / SDK)

To avoid common failures:

1. Use the same byte source for both values:
   - `revealedRecv`
   - `recvHash = sha256(revealedRecv)`
2. Send `recvHash` as plain 64-char hex (no `0x`).
3. Send `revealedRecv` in payload and ensure wallet-extension forwards it unchanged.
4. Keep `username`/`userId` from the same revealed response that produced `recvHash`.
5. Keep reveal ranges large enough to include required JSON fields (`id`, `login`/`username`).

## 7. Security Notes

1. Avoid revealing request bytes containing OAuth secrets.
2. Do not reveal fixed `sent[0..N]` if that can include `Authorization: Bearer ...`.
3. Prefer revealing only minimal `recv` bytes needed for extraction.
4. Treat downloaded/on-chain proofs as public disclosure artifacts.

## 8. Typical Failure Messages

Common errors and meaning:

- `Invalid TLSN recvHash: expected 64-char hex sha256`
  - `recvHash` format is wrong (often `0x` prefix or wrong length).
- `recvHash mismatch: provided hash does not match disclosed recv bytes`
  - Hash computed from node-received `revealedRecv` differs from payload `recvHash`.
- `Failed to extract user from <context> revealedRecv payload`
  - Disclosed bytes do not contain parseable fields for that context.
- `Username mismatch` / `UserId mismatch`
  - Claimed values do not match extracted values from disclosed bytes.
