# bijou64 Integration Analysis — Demos Node & SDK

**Author:** Architecture / Security review
**Date:** 2026-05-30
**Scope:** `kynesyslabs/node` (consensus, p2p, validation) and `kynesyslabs/sdks` (client serialization, signing)
**Verdict:** **Do not adopt bijou64.** It solves a problem this codebase does not have, and it cannot fix the canonicalization risks this codebase *does* have.

---

## 0. Executive summary (TL;DR)

The brief asks us to evaluate replacing a LEB128/varint integer encoding with **bijou64** to (a) eliminate signature‑malleability from non‑canonical varints and (b) speed up block decoding by 2–10×.

After mapping the full serialize → hash → sign → verify path in both repositories, the premise does not match the implementation:

1. **There is no varint anywhere in the security‑critical path.** Transaction and block hashes — the only bytes that are signed and verified — are computed as `SHA256(JSON.stringify(content))`. The signature is made over that hash. bijou64 would change **zero** bytes of what gets signed.
2. **The one binary layer that exists (OmniProtocol p2p framing) already uses fixed‑width big‑endian integers** (`UInt8/16/32/64BE`), not LEB128. Fixed‑width encodings are *already canonical* — one value, one byte pattern — so there is no varint‑malleability bug to fix there either. This layer is also non‑authoritative: it is transport, guarded by a CRC32, and the receiver re‑derives the authoritative hash from JSON content regardless of how the bytes arrived.
3. **The real malleability surface is the JSON serialization itself** — key ordering, number formatting (JS `number` vs decimal string), whitespace, and unicode escaping — plus a concrete divergence bug between the hashing path and the validation path (§2.3). bijou64 addresses **none** of these.
4. **The headline performance claim does not transfer.** The 0.75 ns vs 7.3 ns (≈10×) figure is from the **Rust** implementation and is measured **against LEB128**. We don't use LEB128, and the shipping JS package (`bijective-varint`) is pure TypeScript that its own author says "isn't super optimized." Our block‑decode hot path is dominated by `JSON.parse` + `SHA256` + signature verification, not by integer decoding — and the integers we do decode are fixed‑width reads (`readBigUInt64BE`), which are already branch‑free O(1) and arguably *faster* than any varint.

**Net:** bijou64 is a well‑designed encoding for a different architecture (a fully binary, varint‑based, canonical‑by‑construction wire format such as the Subduction CRDT protocol it was built for). Dropping it into Demos as‑is would add a Wasm/JS dependency and a hard‑fork migration in exchange for no security improvement and no measurable performance gain. The genuinely high‑value work this investigation surfaced is **canonical JSON** and **fixing the coherence/hash divergence** (§5).

---

## 1. Step 1 — How integers are actually encoded today

There are **two distinct encoding layers**, and conflating them is the root of the brief's misframing.

### 1.1 The authoritative layer: JSON (what gets hashed & signed)

This is the only layer that matters for consensus and signatures.

**SDK — signing** (`sdks/src/websdk/demosclass.ts:485‑635`):
```ts
const serialized = serializeTransactionContent(raw_tx.content, isPostFork) // JSON string
raw_tx.hash    = Hashing.sha256(serialized)                                // SHA-256 hex
const signature = await this.crypto.sign(this.algorithm,
                    new TextEncoder().encode(raw_tx.hash))                  // sign the hash
```

**SDK — serializer** (`sdks/src/denomination/serializerGate.ts:323‑331`):
```ts
export function serializeTransactionContent(content, isPostFork): string {
  return isPostFork ? JSON.stringify(transformToPostFork(content))
                    : JSON.stringify(transformToPreFork(content))
}
```

**Node — transaction hash** (`node/src/libs/blockchain/transaction.ts:126‑140`):
```ts
static hash(tx, blockHeight?) {
  const height = blockHeight ?? getSharedState.lastBlockNumber ?? 0
  tx.hash = Hashing.sha256(serializeTransactionContent(tx.content, height))
  return tx
}
```

**Node — block hash** (`node/src/libs/consensus/v2/routines/createBlock.ts:42`):
```ts
block.hash = Hashing.sha256(serializeBlockContent(block.content, blockNumber))
```

**Node — signature verification** (`node/src/libs/blockchain/validation/txValidator.ts:85‑90`):
```ts
const ok = await ucrypto.verify({
  algorithm: tx.signature.type,
  message:   new TextEncoder().encode(tx.hash),     // verifies over the hash string
  publicKey: hexToUint8Array(tx.content.from),
  signature: hexToUint8Array(tx.signature.data),
})
```

Integers in this layer are **JSON values**, not varints:

| Field | Pre‑fork wire | Post‑fork wire | DB storage |
|---|---|---|---|
| `amount` | JS `number` (DEM) | decimal `string` (OS) | `numeric(38,0)` |
| `network_fee`/`rpc_fee`/`additional_fee` | JS `number` | decimal `string` | `numeric(38,0)` |
| `nonce` | JS `number` | JS `number` | `bigint` |
| `timestamp` | JS `number` | JS `number` | `bigint` |

The post‑fork ("osDenomination") path already does a form of canonicalization for amounts: non‑canonical inputs like `"00100"` are normalized via `parseOsString → BigInt → toOsString → "100"` (`node/src/forks/serializerGate.ts:49‑108`, `node/src/forks/amountCanonical.ts:59‑135`).

### 1.2 The transport layer: fixed‑width big‑endian (OmniProtocol p2p)

`node/src/libs/omniprotocol/serialization/primitives.ts` — confirmed fixed‑width, **not** varint:
```
UInt8   → writeUInt8        (1 byte)
UInt16  → writeUInt16BE     (2 bytes)
UInt32  → writeUInt32BE     (4 bytes)
UInt64  → writeBigUInt64BE  (8 bytes)
String  → UInt16 len prefix + UTF-8
VarBytes→ UInt32 len prefix + raw
```
Used by block sync, mempool sync, and consensus messages (`serialization/{transaction,sync,consensus,gcr}.ts`). Crucially, `encodeTransaction` embeds the **entire transaction JSON** as a trailing `VarBytes` field (`serialization/transaction.ts:89‑91`) — the structured binary fields are a convenience index; the JSON is the source of truth on the receiving side.

**Dependencies confirm the picture.** Neither `package.json` contains `varint`, `leb128`, `borsh`, `cbor`, `borc`, `msgpack`, or `protobufjs` (protobufjs is present in the SDK but unused for tx serialization). No LEB128 implementation, manual or otherwise, exists in either repo.

---

## 2. Step 2 — Malleability audit

### 2.1 The varint‑malleability attack bijou64 prevents — does not apply

bijou64's security value is real but specific: in LEB128, `0` can be written `0x00` **or** `0x80 0x00`, so two byte strings decode to the same integer. If you sign raw encoded bytes, an attacker can re‑encode and break/forge signature equality. Demos is immune to this **by construction**, for two independent reasons:

1. We never sign varint bytes. We sign `SHA256(JSON.stringify(content))`. There is no varint in the preimage.
2. The binary transport layer uses **fixed‑width** integers, which are inherently canonical (`5` is always `00 00 00 00 00 00 00 05` as a UInt64BE — there is no second encoding).

### 2.2 The malleability surface we *do* have (JSON)

The signed preimage is a JSON string, so malleability lives in JSON, and bijou64 cannot touch any of it:

- **Key ordering.** No canonical key sort exists; determinism relies on JS object insertion order (`serializerGate` uses `{...content}` spread + in‑place overwrite to preserve it). This is *correct today* but fragile: any code path that reconstructs `content` with a different key order (e.g. `JSON.parse` round‑trips, ORM hydration, restructuring) produces a different hash for identical data.
- **Number formatting.** Pre‑fork `amount` is a JS `number`. `JSON.stringify(1e21)` → `"1e+21"`, large integers lose precision, `-0` vs `0`, etc. This is exactly why the osDenomination fork moved amounts to decimal strings — a JSON‑canonicalization fix, not a varint one.
- **Whitespace / unicode escaping / duplicate keys** in inbound JSON parsed by the node.

### 2.3 Concrete bug found: hash vs coherence divergence

`validateTxCoherence` (`node/src/libs/blockchain/validation/txValidator.ts:20‑30`) recomputes the hash with **plain** `JSON.stringify(tx.content)`:
```ts
const derivedHash = Hashing.sha256(JSON.stringify(tx.content))
```
…while `Transaction.hash` (`transaction.ts:126‑140`) uses the **fork‑aware** `serializeTransactionContent(tx.content, height)`. The code comments acknowledge this (the `REVIEW: P2` note: "in P2 the gate returns identical bytes to JSON.stringify"). They are identical **only while pre/post‑fork serialization is byte‑identical**. The moment the OS‑denomination transform diverges from raw `JSON.stringify` for any field, every post‑fork transaction fails coherence (or, worse, a mismatch is masked). This is a real, present‑day canonicalization risk — and it is a *JSON* problem, orthogonal to bijou64.

**Recommendation:** route `validateTxCoherence` through the same `serializeTransactionContent` used by `Transaction.hash`. This is the single highest‑value security fix to come out of this audit and has nothing to do with integer encoding.

---

## 3. Step 3 — Performance evaluation

### 3.1 Where block‑decode time actually goes

Hot path on block/tx receipt (`node/src/libs/omniprotocol/protocol/handlers/sync.ts`, `mempool.ts:206`):
1. `MessageFramer.extractMessage` — header parse + **CRC32** over the frame.
2. `decode*` — a handful of **fixed‑width** `readBigUInt64BE`/`readUInt16BE` reads (already O(1), branch‑free).
3. `JSON.parse` of the embedded transaction JSON.
4. `SHA256` recomputation for coherence.
5. **Signature verification** (ed25519 / ML‑DSA / Falcon) in a worker pool.

Steps 3–5 dominate by orders of magnitude. Integer decoding (step 2) is already negligible and already O(1).

### 3.2 Why bijou64 wouldn't move the needle

- **Against fixed‑width, bijou64 is not faster to decode.** A fixed‑width `readBigUInt64BE` is a single aligned load with no length branch. bijou64 must read the tag byte, branch on the 248–255 range, then do an offset‑add. The "2–10× faster" claim is **relative to LEB128's continuation‑bit scan**, which we don't use. Replacing fixed‑width with bijou64 trades a branch‑free read for a branchy one — neutral to slightly negative on CPU, with a *bandwidth* win only for small values.
- **The benchmark is Rust, not Bun.** 0.75 ns/value is the Rust impl. The shipping JS package (`bijective-varint`, pure TS, zero deps — **not** a Wasm wrapper as the brief states) is explicitly "not super optimized" by its author. Any JS varint in the hot path competes with V8/JSC‑intrinsic `DataView`/`Buffer` reads and is likely to *lose*.
- **Bandwidth saving is marginal and misplaced.** The wire is already dominated by hex strings (addresses, hashes, signatures) and embedded JSON, not by 8‑byte integers. Shaving a few bytes off `blockNumber`/`timestamp` while still shipping the full JSON blob as `VarBytes` is a rounding error.

**Estimated computational saving in block validation from adopting bijou64: ~0% (within noise).** The lever for validation throughput is signature verification batching and JSON/canonicalization cost, not integer decode.

---

## 4. Step 4 — SDK impact

If bijou64 were adopted at the transport layer (the only place it *could* go), the SDK impact would be:

- Add `bijective-varint` (pure TS, MIT, supports `number` up to 2^53‑1, `bigint` up to 2^128‑1, signed via zigzag). Bun‑compatible, no Wasm needed. Easy mechanically.
- But the SDK's signing path (§1.1) produces **JSON**, then hashes it. To get any security benefit from bijou64's canonicality you would have to move the **signed preimage** from JSON to a fully binary, bijou64‑based format and guarantee the validator reconstructs byte‑identical input. That is a redesign of the transaction format and the signature scheme — a far larger change than "swap the integer codec," and it forces a hard fork plus a coordinated SDK/node release with byte‑for‑byte cross‑implementation conformance tests.
- bijou64 only covers **integers**. Addresses, hashes, and signatures are variable‑length byte strings; a binary canonical format still needs canonical rules for those (length‑prefix, ordering), which bijou64 does not provide. You'd be reinventing Borsh/SSZ‑style canonical serialization, of which bijou64's varint is one small component.

---

## 5. Step 5 — Recommendations & migration

### Recommendation: do not integrate bijou64. Pursue the JSON‑canonicalization issues instead.

| Priority | Action | Files | Why |
|---|---|---|---|
| **P0** | Make `validateTxCoherence` use the fork‑aware serializer (or assert byte‑equality with the hashing path) | `node/.../validation/txValidator.ts:20‑30` vs `transaction.ts:126‑140` | Real, present divergence risk (§2.3) — the only live malleability bug found |
| **P1** | Adopt canonical JSON (RFC 8785 / JCS) for the signed preimage: sorted keys, fixed number form, no insignificant whitespace, defined unicode escaping | `sdks/src/denomination/serializerGate.ts`, `node/src/forks/serializerGate.ts` | Closes the *actual* malleability surface (§2.2) that bijou64 cannot |
| **P1** | Finish migrating all monetary fields off JS `number` to decimal strings/bigint (continue the osDenomination direction) | denomination modules in both repos | Removes float‑formatting malleability |
| **P3** | *If and only if* a future redesign moves to a fully binary signed format, re‑evaluate canonical varints — bijou64, SSZ, or Borsh — as one component, behind a protocol‑version bump | — | Only context where bijou64's canonicality‑by‑construction pays off |

### If leadership still wants a binary canonical wire format (the real "bijou64 use case")

Treat it as a **protocol‑version / hard‑fork** project, not a codec swap:

1. **Spec first.** Define a canonical binary transaction/block format end‑to‑end (field order, integer encoding, byte‑string length prefixes, map ordering). bijou64 would be the integer primitive; you still need canonical rules for everything else.
2. **Cross‑impl conformance vectors.** Golden test vectors that both SDK and node must encode byte‑identically (extend the existing `serializerGate.test.ts` / `roundTripHash.test.ts` discipline already in the SDK).
3. **Dual‑hash transition.** Like the current pre/post‑fork gate: accept old‑format hashes until the fork height, switch the signed preimage at activation, keep the JSON blob available for indexers during the overlap.
4. **Version negotiation in OmniProtocol.** The frame header already carries a `version` field (`MessageFramer.ts`) — use it to gate the new payload format during rollout.

But note this is justified by *determinism and wire size of a full binary format*, **not** by the varint‑malleability or decode‑speed arguments in the original brief, both of which this codebase already neutralizes.

---

## Appendix — bijou64 fact‑check vs the brief

| Brief's claim | Reality |
|---|---|
| "Canonicality eliminates signature malleability (Bitcoin/ASN.1‑style)" | True of bijou64 in the abstract; **not applicable here** — we sign `SHA256(JSON)`, and the binary layer is fixed‑width (already canonical). |
| "2–10× faster decode than LEB128, O(1) from first byte" | True vs **LEB128**; we don't use LEB128. vs our fixed‑width reads it is neutral‑to‑slower. O(1) is also already true of fixed‑width. |
| "Wasm/JS wrapper ready for Bun" | **Inaccurate.** Shipping lib `bijective-varint` is **pure TypeScript, zero deps** (Bun‑friendly, but not Wasm). Author notes it "isn't super optimized"; the fast numbers are the Rust impl. |
| "We use varint/LEB128 we can replace" | **False.** No varint/LEB128 in either repo. Authoritative layer is JSON; transport layer is fixed‑width BE. |

**Sources on bijou64:** Ink & Switch, *bijou64* (Subduction CRDT protocol); npm `bijective-varint` (Joseph Gentle, MIT, pure TS).
