import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { hexToUint8Array } from "@kynesyslabs/demosdk/encryption"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"

/**
 * Per-peer vote outcome. The `signaturesToMerge` map carries every
 * signature the peer attached to its response **after** caller-side
 * verification against the candidate block hash; entries that failed
 * verification are dropped before this object is constructed so the
 * aggregator never has to second-guess validity.
 */
interface PeerVoteOutcome {
    peerId: string
    vote: "pro" | "con"
    signaturesToMerge: Record<string, string>
    rejectionReason?: string
}

/**
 * Verify every incoming signature in parallel against the candidate
 * block hash and return only the verified ones. Failures are logged
 * but do not abort the routine — peers can legitimately ship
 * signatures from other peers that haven't yet been published, and
 * the aggregator merges what we can trust.
 *
 * Returns the verified subset as `{identity: signature}` so the
 * caller can hand it to the aggregator without re-verifying.
 */
async function verifyIncomingSignatures(
    incoming: Record<string, string>,
    candidateBlockHash: string,
    peerId: string,
): Promise<Record<string, string>> {
    const entries = Object.entries(incoming)
    const checks = await Promise.all(
        entries.map(async ([identity, signature]) => {
            try {
                const isValid =
                    await TxValidatorPool.getInstance().verify({
                        algorithm: getSharedState.signingAlgorithm,
                        message: new TextEncoder().encode(candidateBlockHash),
                        signature: hexToUint8Array(signature),
                        publicKey: hexToUint8Array(identity),
                    })
                // `loggedFailure` marks whether the inner catch path
                // already emitted an error for this entry — so the
                // outer aggregator can skip its own "Invalid
                // signature" log and avoid double-noise (PR #888
                // Greptile P2).
                return {
                    identity,
                    signature,
                    isValid,
                    loggedFailure: false,
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                log.error(
                    `[broadcastBlockHash] Signature verification threw for ${identity} (relayed by ${peerId}): ${msg}`,
                )
                return {
                    identity,
                    signature,
                    isValid: false,
                    loggedFailure: true,
                }
            }
        }),
    )

    const verified: Record<string, string> = {}
    for (const { identity, signature, isValid, loggedFailure } of checks) {
        if (isValid) {
            verified[identity] = signature
        } else if (!loggedFailure) {
            log.error(
                `[broadcastBlockHash] Invalid signature relayed by ${peerId} for ${identity}; dropping. ` +
                    `Candidate block hash: ${candidateBlockHash}`,
            )
        }
    }
    return verified
}

/**
 * Per-peer flow: call the peer's `proposeBlockHash`, classify the
 * response as pro/con, and (on pro) collect the signatures the peer
 * attached. Never throws — a network failure becomes a `con` vote
 * with a rejection reason so the aggregator counts votes accurately.
 */
async function proposeAndCollect(
    peer: Peer,
    block: Block,
    proposeParams: [string, Block["validation_data"], string],
): Promise<PeerVoteOutcome> {
    const peerId = peer.identity
    let response: RPCResponse
    try {
        response = await peer.longCall(
            {
                method: "consensus_routine",
                params: [
                    {
                        method: "proposeBlockHash",
                        params: proposeParams,
                    },
                ],
            },
            true,
            {
                allowedCodes: [401],
            },
        )
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log.error(
            `[broadcastBlockHash] longCall to ${peerId} threw (counts as con): ${msg}`,
        )
        return {
            peerId,
            vote: "con",
            signaturesToMerge: {},
            rejectionReason: `longCall threw: ${msg}`,
        }
    }

    if (response.result !== 200) {
        const extraMessage =
            typeof response.extra === "object" && response.extra !== null
                ? (response.extra as { message?: string }).message
                : undefined
        log.error(
            "[broadcastBlockHash] Block hash not confirmed by validator " +
                `${peerId}: result=${response.result} message=${extraMessage}`,
        )

        // Diagnostic dump preserved from prior implementation — helps
        // operators investigate why two shard members disagreed on
        // the candidate block content. The mismatched-block payload
        // is only present on the 401 branch from
        // `manageProposeBlockHash`; guard accordingly.
        const extra = response.extra as
            | { ourBlock?: { txHashes?: string[]; ordered_transactions?: string[] } }
            | undefined
        if (extra?.ourBlock) {
            const theirTxHashes: string[] =
                extra.ourBlock.txHashes ??
                extra.ourBlock.ordered_transactions ??
                []
            const ourTxHashes: string[] =
                getSharedState.candidateBlock.content.ordered_transactions
            const theirSet = new Set(theirTxHashes)
            const ourSet = new Set(ourTxHashes)
            const missingFromUs = theirTxHashes.filter(h => !ourSet.has(h))
            const missingFromThem = ourTxHashes.filter(
                h => !theirSet.has(h),
            )
            log.error(
                `[broadcastBlockHash] tx-set diff with ${peerId}: ` +
                    `missingFromUs=${missingFromUs.length}, ` +
                    `missingFromThem=${missingFromThem.length}`,
            )
            log.error("Missing from us: " + JSON.stringify(missingFromUs, null, 2))
            log.error("Missing from them: " + JSON.stringify(missingFromThem, null, 2))
            log.debug(
                `[broadcastBlockHash] Their block: ${JSON.stringify(
                    extra.ourBlock,
                    null,
                    2,
                )}`,
            )
        }

        return {
            peerId,
            vote: "con",
            signaturesToMerge: {},
            rejectionReason: `HTTP ${response.result}`,
        }
    }

    // 200 path — receiver agreed with our block hash. `response.extra`
    // is its `candidateBlock.validation_data` (see
    // `manageProposeBlockHash.ts` line 104). `response.response` is
    // the receiver's pubkey hex; `extra.signatures[response.response]`
    // is its signature over our block hash.
    const extra = response.extra as
        | { signatures?: Record<string, string> }
        | undefined
    const incomingSignatures = extra?.signatures ?? {}

    // PR #888 Greptile P1: a `pro` vote must carry cryptographic
    // proof of agreement, not just an HTTP 200. A peer returning
    // 200 with no signatures, or a signatures bundle that fails
    // verification entirely, contributes no auditable evidence to
    // `block.validation_data.signatures` — counting such a vote
    // would mean BFT quorum can be reached on responses no one can
    // later prove came from the claimed validators. Treat as `con`
    // with an explicit rejectionReason so the operator can
    // distinguish "peer attacked us" from "peer disagreed".
    if (Object.keys(incomingSignatures).length === 0) {
        log.error(
            `[broadcastBlockHash] ${peerId} returned 200 but attached no signatures; treating as con`,
        )
        return {
            peerId,
            vote: "con",
            signaturesToMerge: {},
            rejectionReason: "200 with empty signatures map",
        }
    }

    const verified = await verifyIncomingSignatures(
        incomingSignatures,
        block.hash,
        peerId,
    )

    // PR #888 Greptile P1 (continued): a peer's signature on our
    // block hash is the canonical attestation that this peer voted
    // pro. We require it to be present AND verified before counting
    // the vote. If the peer only relayed third-party signatures
    // (e.g. malformed bundle dropped on verify, or 200 with only
    // OTHER validators' signatures), that's a `con` — relayed
    // signatures alone are not a vote.
    if (!Object.prototype.hasOwnProperty.call(verified, peerId)) {
        log.error(
            `[broadcastBlockHash] ${peerId} returned 200 but its own signature is missing or failed verification; treating as con`,
        )
        return {
            peerId,
            vote: "con",
            signaturesToMerge: {},
            rejectionReason:
                "200 without verifiable own signature on block hash",
        }
    }

    return {
        peerId,
        vote: "pro",
        signaturesToMerge: verified,
    }
}

/**
 * Broadcasts our candidate block hash to every shard member,
 * collects each peer's vote (pro/con), and merges the per-peer
 * signatures that survive verification into our candidate block's
 * `validation_data.signatures` map.
 *
 * Returns `[pro, con]` — the actual peer vote counts, NOT a
 * signature count. BFT threshold computation in
 * {@link isBlockValid} expects vote counts; using signature count
 * would conflate "this peer attested to our block" with "this peer
 * relayed a third party's attestation" and inflate the tally past
 * what 2/3+1 implies.
 *
 * Concurrency notes (audit-sweep batch D):
 *  - Per-peer outbound calls run in parallel via `Promise.all`.
 *    Each one is wrapped in a try/catch so a single peer's network
 *    failure becomes a `con` vote with a rejection reason, not a
 *    routine-level abort. `Promise.allSettled` semantics achieved
 *    by always resolving (never rejecting) from inside the map.
 *  - Per-peer signature verification runs in parallel inside the
 *    per-peer flow (`verifyIncomingSignatures`).
 *  - Signature merge into `block.validation_data.signatures` is
 *    serialised AFTER all peer outcomes settle — single sequential
 *    pass over the aggregated outcomes. This eliminates the
 *    fire-and-forget race the previous implementation had where
 *    `.then` callbacks mutated `signatures` after the routine
 *    returned, leaving the caller (`voteOnBlock`) to consume a
 *    half-populated map.
 *
 * The previous implementation also commented out the
 * `[pro, con]` return and instead returned
 * `[signatureCount, shard.length - signatureCount]`. That broke BFT
 * semantics — concurrent inbound `manageProposeBlockHash` calls
 * write into the same `signatures` map (because `block` IS
 * `getSharedState.candidateBlock`), so `signatureCount` reflected
 * not just our outbound peer votes but every signature any shard
 * member happened to relay during our broadcast window. This PR
 * restores vote-count semantics.
 */
export async function broadcastBlockHash(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    const ourId = getSharedState.publicKeyHex

    // PR #888 Greptile P2: snapshot `validation_data` once before
    // fan-out. The receiver-side `manageProposeBlockHash` runs
    // concurrently with our outbound broadcast (every shard member
    // is calling every other simultaneously), and any inbound call
    // mutates `getSharedState.candidateBlock.validation_data.
    // signatures` — which is the SAME object as
    // `block.validation_data`. Passing that live reference to every
    // peer means each outbound call serialises a slightly different
    // payload depending on what landed first. A `structuredClone`
    // freezes the payload at fan-out time so every peer sees the
    // same `validation_data` snapshot. Receivers still verify and
    // merge what they get; the freeze only affects what we ship.
    const validationDataSnapshot = structuredClone(block.validation_data)
    const proposeParams: [string, Block["validation_data"], string] = [
        block.hash,
        validationDataSnapshot,
        ourId,
    ]

    const outcomes = await Promise.all(
        shard.map(peer => proposeAndCollect(peer, block, proposeParams)),
    )

    let pro = 0
    let con = 0

    // Serial merge: each `Object.assign` operation against the
    // shared `signatures` map is atomic, but we want a single
    // deterministic order so log lines reflect what landed and
    // operators can replay the merge if needed.
    for (const outcome of outcomes) {
        if (outcome.vote === "pro") {
            pro++
            const added = Object.entries(outcome.signaturesToMerge)
            for (const [identity, signature] of added) {
                block.validation_data.signatures[identity] = signature
            }
            if (added.length > 0) {
                log.debug(
                    `[broadcastBlockHash] Merged ${added.length} verified ` +
                        `signatures relayed by ${outcome.peerId}`,
                )
            }
        } else {
            con++
        }
    }

    log.info(
        `[broadcastBlockHash] Vote tally for block ${block.hash}: ` +
            `pro=${pro}, con=${con} (shard size=${shard.length})`,
    )

    // TODO: Transmit received votes to the other nodes to help with
    // failures (pre-existing follow-up, unrelated to the vote-race
    // fix).

    return [pro, con]
}
