# RFC: Verifiable DACS sealed-auction candidate sets on Demos

Status: **proposal, not implemented or registered**. This document does not make
`negotiate-sealed-envelope-complete` available on Demos. Until a reviewed node
implementation, independent witnesses, a registered binding definition, and
conformance evidence exist, consumers must return capability-missing /
`indeterminate` as required by DACS-3 §8.4.4 and the Demos mapping §A.4.

## Problem and authority boundary

A bidder can anchor a signed commit or reveal in a public Storage Program, but
today's Storage Program read API answers only whether a *known native address*
has content. It does not prove that a query returned **every** bidder-owned
write for `dacs3:auction:{jobId}`. A seller-controlled index, an L2PS inbox,
or several positive reads can therefore omit the best bid while appearing
internally consistent. The complete profile requires an authenticated,
current-finalized set, not merely an integrity check on found records.

This proposal puts the enumeration authority at the finalized Demos block
history. A database index may accelerate lookup, but it is never itself the
proof. The replay and witness policy below is the proposed first Demos binding;
its identity and version are deliberately **not allocated** until the node
implementation and policy are reviewed and registered under SAC-3.

## Proposed native evidence contract

The node exposes an immutable, bounded **block-range evidence stream** and an
optional derived prefix-query response. The stream starts at genesis (or a
separately authenticated checkpoint whose prior prefix state is committed) and
ends at one BFT-finalized block. It contains contiguous block headers and
validation certificates and the body of **every** ordered transaction. The
verifier checks each transaction hash and signature and deterministically
replays the pinned state-transition rules to derive Storage Program write
results. A server-supplied write result is not authority: today's block
`native_tables_hashes` does not commit the Storage Program table. A future
consensus-committed auction-event/result root could replace full replay only
under a separately specified, verified codec. A missing block, transaction,
unexecutable transition, or validation certificate is `indeterminate`; an ordinary RPC
`not found` never proves absence. Existing `getBlocks`, `getBlockTransactions`,
and `GET /storage-program/:address` responses are not such a proof by
themselves. Replay must validate the block-hash rule active at each historical
height; the proposed deterministic block-hash fork in node PR #995 is a
separate consensus dependency, not a reason to reinterpret older block bytes.
The block height used for ordering comes from the authenticated contiguous
chain position starting at the pinned genesis, not an uncommitted `number`
field on an isolated block. A checkpoint shortcut needs a pinned exact codec,
prefix-state commitment, governance authorization, and replay rule.

The immutable binding definition must also pin the network and genesis, the
validator-roster authority and epoch transitions, the block-signature domain
and algorithm, the quorum threshold, and certificate-to-block-hash rule. A
validator list or signature set supplied solely inside the candidate block
cannot authenticate itself. Unsupported historical consensus rules or an
unverifiable roster transition leave the set `indeterminate`.

For every finalized Storage Program write, the verifier derives the exact
logical address from the immutable write payload, not a mutable program name
or an Indexer label. Only records with the canonical
`dacs3:auction:{jobId}:commit:...` or `:reveal:...` address enter that job's
collection. The write must preserve the signed `SealedAuctionRecord` bytes,
the logical address, native address, transaction hash, writer, nonce, block
height and timestamp, transaction position, and write position. If the current
Storage Program operation cannot carry and preserve these values, the node
change must add a distinct immutable auction-record write operation; it must
not infer them from mutable JSONB rows after the fact. Deletion or update of a
Storage Program cannot erase a finalized auction write from enumeration.

The first binding should admit only DACS-1 §6.3.1's canonical
`did:demos:agent:<64-lowercase-hex-ed25519-public-key>` bidder claims. The
native transaction's authenticated Ed25519 writer public-key bytes must equal
the 32 bytes decoded from that exact claim component, and the DACS record
signature must use `algorithm: "ed25519"` and verify under the same key over
`UTF8("dacs-sealed-auction-record:v1:") || recordContentHash`. This direct mapping
does not equate a native address string with a ClaimReference.
Other claim forms remain unsupported until a separately specified, verifiable
native-writer admission mapping exists. The listing fixes this binding before
commit; it cannot change the admission policy after bids are visible.

The derived response contains every matching write at one finalized state,
including malformed, duplicate, late, and conflicting writes. It must not
filter to eligible bids or choose a winner. Each entry includes the exact
`AttestationRef`, finalized `AnchorReceipt`, and an `orderKey` derived from
the consensus order `(block height, transaction position, write position)`.
The verifier recomputes `recordCount` and `sha256(JCS(entries))`, using the
canonical SAC-4 entry ordering. An API-supplied count/hash is an assertion to
check against replay, not an authority in its own right.

Two different finalized contents at one logical address make that address
conflicted and the whole selection `indeterminate` unless a registered
consensus rule proves one canonical outcome. Exact repeated content remains
visible as repeated writes for SAC-5 duplicate classification; a last-write
database view cannot silently choose one. Forks or incompatible finalized
histories similarly remain `indeterminate` pending authenticated reconciliation.

## Currentness and independent observation

A valid old block is not necessarily a current auction snapshot. The proposed
binding definition must pin a governance-authenticated roster of **three
independent operators** and require matching signed observations from at least
**two** of them. Each observation binds network ID, finalized block height and
hash, consensus timestamp, collection prefix, ordered record-set hash/count,
and an expiry. The observer must independently replay the chain to that state
and refuse to sign a partial result. Operators, public keys, replacement
procedure, and independence criteria must be published in the immutable
definition; a seller or auction orchestrator cannot appoint the witnesses for
its own job. This is an explicit trust assumption, not a cryptographic claim
that a single node's query proves non-omission: the policy assumes at most one
of the three independently operated witnesses signs a false view. If that
assumption cannot be established, this witness policy cannot be registered.

The registered policy must choose an exact maximum lag measured against the
witnesses' independently authenticated finalized tips. A snapshot below the
reveal deadline, outside that lag, expired, or disputed by a same-height fork
is `indeterminate`. The proposal intentionally leaves the numerical lag and
roster unregistered until Demos operators can demonstrate their real finality
and availability bounds; a guessed value would be an unsafe production policy.

The binding must cap records and bytes per job and cap proof processing, with
declared values in its immutable definition. Exceeding a ceiling fails the
auction. Pagination must carry a proof of the full range and exact total;
reaching a page limit or timing out must never produce a smaller successful
set. A verifier may stream the full range without retaining all block bodies,
but it must authenticate every step from the trusted checkpoint to the chosen
finalized state.

## Node PR acceptance boundary

The implementation PR is complete only when an independent client can:

1. verify the finalized block/certificate chain, all ordered transaction
   bodies/signatures, and pinned state transitions to derive every write,
   without trusting the prefix-query server;
2. reproduce the same ordered entries, receipts, count, and hash from two
   independent observers at one current finalized state;
3. reject an omitted, substituted, truncated, duplicated, stale, wrong-writer,
   wrong-prefix, conflicting-address, or forked view; and
4. resume or return `indeterminate` on unavailable blocks, witness evidence,
   finality, or authority, never promote a partial result to success.

Offline tests should cover those cases plus a valid empty auction, a valid
multi-bidder auction, per-job resource ceilings, witness-key rotation, and
replay from a checkpoint. A production claim additionally requires real Demos
finality/throughput evidence and an immutable registered definition; mocked
signatures or a synthetic test-BFT fixture alone do not establish it.

After this mechanism is implemented, the DACS Standard can register the exact
`CandidateSetBindingRef` and proof codec in a separate reviewed PR. The DACS
SDK may then implement SAC-2..SAC-12 against that pinned definition. No part
of this RFC changes the historical §8.4.3 sealed-envelope semantics.
