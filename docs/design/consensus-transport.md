# Consensus transport: peer calls off the client RPC port

Status: implemented for rc.8. No fork; mixed rc.7/rc.8 networks keep working.

## Problem

Under a client transaction flood (rc.7 load drill, 2026-11-11) block times
spiked to 45-71 s. Two causes:

1. `OMNI_MODE=OMNI_PREFERRED` never used OmniProtocol. A peer is called over
   Omni only once it is in the adapter's `omniPeers` set, and nothing ever
   added one (`markPeerOmniCapable` had no callers). Every consensus and
   mempool-merge call went over HTTP to the peer's RPC port, which the flood
   saturates: merge calls timed out (504), peers were marked offline, the
   shard fell below its minimum, and secretary calls failed.
2. A proposal that reached a validator while its own round was still merging
   mempools got an immediate 404 "Candidate block not formed". The proposer
   counted that as a con vote; the round was lost and the members then waited
   out the secretary's 30 s phase timeout.

## Design

### Which peers use Omni

- A node whose Omni server runs on plain TCP adds `omni: { port }` to its
  hello replies. The port is the one it actually listens on, not a guess.
  With Omni TLS on it advertises nothing: the outbound connection pool only
  speaks plain TCP.
- The caller records the port only from a hello reply verified as signed by
  the key it dialed, over its nonce and the URL it dialed
  (`PeerManager.helloPeerCallback`, verdict `verified`). The record holds the
  origin of that URL and the port.
- Calls dial the verified URL's host at the advertised port. If the peer's
  URL later moves to another origin, the record no longer applies and the
  peer is called over HTTP until a verified reply from the new address.
- A verified reply without the field (rc.7, Omni off, TLS) drops the record.
  Unsigned replies never change it.
- Calls to ourselves go to the loopback Omni port.
- `OMNI_ONLY` keeps the RPC port + 1 fallback for peers without a record.

The port itself is not under the hello signature: changing the signed message
would break verification with rc.7 peers. Anyone able to rewrite the reply
could already rewrite everything else in it; the port can only point to
another port on the host that proved the URL, and every Omni request still
carries our signed auth block.

### Failures

- Connect failure (port closed, filtered, refused): fall back to HTTP for
  that call and keep the peer on HTTP for a cooldown that starts at 60 s and
  doubles with each failure in a row, up to 10 minutes. An Omni answer resets
  it; a repeated hello with the same advert does not. The connect timeout is
  capped at the call's own timeout, so a dead advertised port costs at most
  one call timeout per cooldown.
- No answer within the call's timeout on a live connection: a 504, as HTTP
  reports it. The connection stays open: the request's entry is dropped and
  a late answer is ignored by its sequence number, while the other requests
  on the connection carry on. No HTTP resend, no cooldown, and the peer
  stays in the online table: one slow answer on a live connection is not
  a dead peer, and dropping it is what took the shard below its minimum.
- The connection drops with the request on it: a 503 and no HTTP resend, as
  the peer may already have acted on the request. The caller's retry
  reconnects over Omni.
- An answer that arrives but cannot be decoded: a 502 and no HTTP resend,
  as the peer has the request. Later calls to that peer use HTTP for the
  cooldown.
- The per-attempt timeout is one value for both transports
  (`CallOptions.timeoutMs`, default 3 s; Omni's was 30 s). Mempool merge
  makes one attempt per batch with its whole 10 s budget, so a receiver
  still validating a batch is not sent it again, and no retry runs on after
  the merge stopped waiting.
- A burst of first calls to a peer shares one connect instead of opening a
  socket each beyond the per-peer cap, which the receiver would close again.
- Calls that ask for `protocol: "http"` stay on HTTP. Only Sync does, for
  block replies: Omni frames are capped at 10 MB, block batches are not.

### Server side

The plain-TCP Omni server (`ConnectionPool.handleInboundSocket` and
`PeerConnection`) already runs the messages of one connection side by side
and answers each by sequence number, so a consensus call does not wait for a
mempool merge from the same peer. Nothing changes there. The TLS server's
older `InboundConnection` still runs them one after another; peers do not
reach it, because a TLS node advertises no Omni port.

### Candidate not formed yet

`ensureCandidateBlockFormed` waits up to 2 s (polling every 100 ms) for the
running round to form the candidate, and stops early if the round ends.
2 s stays under the proposer's 3 s attempt timeout; each of the proposer's
retries waits again. The vote checks that follow are unchanged.

## Not done

- **Skipping the 30 s phase-6 wait in a lost round.** A round with no quorum
  at broadcast time is not provably lost: the candidate keeps collecting
  prevotes from late proposals during that wait (`mergeSignaturesForCandidate`),
  and under `commitLock` the proof of lock is read only after it. Aborting
  early could drop rounds that complete today. Left as is.
- **Client RPC admission.** All work shares one event loop. Omni takes peer
  calls off the HTTP request queue, not off the CPU; bounding concurrent
  client transaction handling is the next lever if spikes remain.
