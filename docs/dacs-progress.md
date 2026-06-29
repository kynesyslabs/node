# DACS / SR-4 — Progress & Next Slice

Author: shitikyan
Date: 2026-06-18
Status: Substrate complete (merged); negotiation layer pending.

## 1. Where we are

DACS-3 needs a private negotiation channel (SR-4) satisfying CH-1..CH-6
(DACS-3 §8.3.1). The substrate that enforces those properties is built
and merged. The negotiation flows that *consume* it are not yet built.

### Done — substrate (all merged)

| Piece | What | Where |
|---|---|---|
| SR-4 SDK — WI-1 | CCI membership binding (`L2PSMembershipBinding`, `resolveMember`), anchored via SR-2 storage program, signed under `dacs-binding:v1:` | sdks#94 |
| SR-4 SDK — WI-2 | `ChannelMessage` envelope: per-channel monotonic sequence, CCI-key signing (`dacs-channelmsg:v1:`), channelId-uniqueness registry (CH-6), transcript export | sdks#94 |
| SR-4 SDK — WI-3 | `anchorEncryptedTranscript`: member-decryptable transcript, public content hash, signed `dacs-transcript:v1:` | sdks#94 |
| L2PS transport | subnet tooling, instant-messaging server, balance pre-checks, batch→L1 nonce fix | node #936/#937/#943/#944/#945 |
| Identity invariant | in-channel signer = Demos ed25519 = CCI primary key = on-chain party (DACS-3 §0) | structural — already aligned |

SR-4 SDK: 109 unit tests green. L2PS transport: verified end-to-end on
the dev devnet (subnet config → encrypt/decrypt → mempool → batch→L1).

### Not done — negotiation layer on top

- **Transport wiring** — nothing yet carries signed `ChannelMessage`s
  over the L2PS messaging transport. The SDK is transport-agnostic by
  design (it returns/verifies envelopes; the caller delivers).
- **Negotiation orchestration** — `negotiate-rfq` (private offer/counter)
  and `negotiate-sealed-envelope` (commit-then-reveal) phase logic.
- **AgreementDocument co-sign** — the in-channel CCI identity co-signs
  the final committed agreement (closes the §0 chain of custody).
- **E2E** — a full negotiate session between two agents on live devnet.

## 2. Integration assessment — L2PS messaging ↔ SR-4

Both layers are individually solid and share the same identity key
(Demos ed25519 = CCI primary key), so transport-auth and channel-signing
are consistent with no bridging. But they are currently **disjoint** —
the L2PS messaging message model (from/to/uid/hash/encrypted/status) does
not carry the `ChannelMessage` envelope, and nothing routes one over the
other.

Four gaps to close for a clean DACS channel over L2PS messaging:

1. **Ordered delivery** — `ChannelSession.receiveIncoming` rejects
   out-of-order / gapped sequences (throws); L2PS messaging delivers by
   timestamp + offline queue and can reorder. Needs a reorder buffer at
   the adapter (or buffer-and-apply in the session).
2. **channelId routing** — L2PS messaging routes by (from,to,uid) pairs;
   a DACS channel is N-party grouped by `channelId`. Either adopt the
   convention *1 channelId = 1 subnet (uid)* or add `channelId` to the
   message model.
3. **DACS message type** — add a `"dacs"`/`"channel"` transport message
   type (or reuse `"system"`) so the transport distinguishes DACS
   envelopes from chat. The DACS `type` (offer/counter/…) lives *inside*
   the envelope.
4. **Anchor de-dup** — L2PS messaging already rolls per-message hashes to
   L1; SR-4 anchors a separate encrypted transcript. For DACS conformance
   the SR-4 transcript anchor is the one that counts — don't double-anchor.

**Design call:** keep the SR-4 SDK transport-agnostic. Do the wiring in a
thin **adapter** (DACS consumer / SDK helper), not in the node messaging
code. The only node-side addition worth considering is first-class
channelId grouping; otherwise document the 1-subnet-per-channel
convention.

## 3. Next slice — `negotiate-rfq` end-to-end

The thinnest vertical slice that demos a real DACS negotiation and
exercises every substrate piece. Build in order.

### WI-A — Channel-over-L2PS adapter

Bridge signed `ChannelMessage` envelopes onto the L2PS messaging
transport.

- `send(channelMsg)` → serialize envelope → L2PS messaging `send` with a
  `dacs` message type, encrypted under the subnet key.
- `onReceive` → deserialize → **reorder buffer** keyed on `sequence` →
  `session.receiveIncoming` in order.
- Map `channelId` to the subnet `uid` (1 channel = 1 subnet) for routing.

**DoD:** two clients on one subnet exchange signed `ChannelMessage`s in
both directions; out-of-order arrivals are buffered and applied in
sequence; a non-member (no subnet key) cannot read.

### WI-B — `negotiate-rfq` phase logic

Implement the offer/counter/accept/reject state machine (DACS-3 §8.4 —
**spec needed** for exact body shapes).

- Members fixed at open via WI-1 bindings; reject messages from unbound
  members.
- Drive the session via WI-A; enforce CH-5 termination (agreement /
  reject / timeout).

**DoD:** an `offer → counter → accept` round completes with a terminal
state; every message signature + sender∈members + monotonic sequence
verified by the receiver.

### WI-C — Transcript anchor on terminal state

On `encrypted-anchored-required` policy, call
`anchorEncryptedTranscript` (WI-3) at termination and carry the
`channelTranscriptRef` in the rfq output.

**DoD:** terminal session produces a member-decryptable, hash-verifiable
anchor; absence fails the phase under `required`.

### WI-D — AgreementDocument co-sign

The accepting party's in-channel CCI identity co-signs the final
AgreementDocument (DACS-3 §8.5.1), proving in-channel signer == on-chain
party.

**DoD:** the AgreementDocument carries co-signatures verifiable against
the same CCI claims that signed the channel messages.

### WI-E — E2E harness

Single-command, hermetic: spin up the devnet subnet, run two agent
identities through a full `negotiate-rfq` round, assert the anchored
transcript + co-signed agreement. (Matches our existing E2E style.)

## 4. Blockers / dependencies

- **DACS-3 spec** (`spec/DACS-3-NEGOTIATE.md` §8.4.3 sealed-envelope
  bodies, §8.7 disclosure policy, §8.5.1 AgreementDocument) — referenced
  by the SR-4 brief but **not present in our repos**. WI-B onward needs
  it for exact message/body shapes.
- **Where orchestration lives** — DACS consumer app
  (agent-commerce-demo) vs a new SDK `negotiate` module. WI-A/B should
  land wherever the consumer is.

## 5. One-line status for stakeholders

The SR-4 substrate (CH-1..CH-6 primitives) is complete and merged —
CH-1..6 enforcement now lives in the substrate, not the app layer. The
`negotiate-*` flows that consume it are the remaining work; first
deliverable is the `negotiate-rfq` end-to-end slice (WI-A..E), gated on
access to the DACS-3 §8.4 spec.
