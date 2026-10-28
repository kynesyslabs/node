import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"
import _ from "lodash"
import TxValidatorPool from "@/libs/blockchain/validation/txValidatorPool"
import {
    countCommitLock,
    countLockMoved,
} from "@/features/metrics/consensusMetrics"
import {
    checkBlockSignature,
    DoubleSignError,
    loadSigningRecord,
    recordBlockSignature,
    SigningRecordError,
} from "src/libs/identity/signingRecord"
import type Peer from "src/libs/peer/Peer"
import PeerManager from "src/libs/peer/PeerManager"
import { emptyResponse } from "src/libs/network/server_rpc"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { getBoundCommittee } from "../routines/getShard"
import {
    COMMITTED_HEIGHT_RESULT,
    type CommittedReport,
    readCommittedRefusal,
} from "../routines/committedBlock"
import {
    commitLockActive,
    isBlockHash,
    isRound,
    precommitMessage,
    roundAheadRefusal,
} from "./domain"
import {
    CommitLockError,
    commitLockPath,
    judgeLock,
    loadCommitLock,
    writeCommitLock,
} from "./lockStore"
import { precommitAfterPrevoteRefusal } from "./prevoteRecord"
import { openPrevote, type PrevoteState, withLockMutex } from "./roundState"
import {
    admitPrecommits,
    commitQuorum,
    isSignatureMap,
    type PrecommitBook,
    precommitBook,
    proofOfLock,
} from "./votes"

export interface PrecommitRequest {
    height: number
    round: number
    hash: string
    /** Verified committee prevotes for `hash` in `round`. */
    pol: Record<string, string>
}

export type PrecommitOutcome =
    | { signature: string }
    | { refused: string }

// The precommit this process signed last: asked again for the same block
// and round, it is handed out again rather than signed a second time.
let lastPrecommit: {
    height: number
    round: number
    hash: string
    signature: string
} | null = null

/**
 * Lock on `hash` and precommit it in `round`, or refuse. The lock is
 * durable before the precommit is signed, so a precommit never exists
 * without the lock that binds every later round. Only the block of our
 * open prevote in that very round is precommitted: see roundState.
 */
export function lockAndPrecommit(
    request: PrecommitRequest,
    book: PrecommitBook = precommitBook,
): Promise<PrecommitOutcome> {
    return withLockMutex(() => lockAndPrecommitLocked(request, book))
}

async function lockAndPrecommitLocked(
    request: PrecommitRequest,
    book: PrecommitBook,
): Promise<PrecommitOutcome> {
    const { height, round, hash } = request
    if (
        lastPrecommit &&
        lastPrecommit.height === height &&
        lastPrecommit.round === round &&
        lastPrecommit.hash === hash
    ) {
        return { signature: lastPrecommit.signature }
    }

    const outcome = await precommitUnderLock(request, {
        identityFile: getSharedState.identityFile,
        genesisHash: getSharedState.genesisBlockHash,
        production: getSharedState.PROD,
        now: getNetworkTimestamp(),
        prevote: openPrevote(height, round, hash),
        sign: async message => {
            const signed = await TxValidatorPool.getInstance().sign(
                getSharedState.signingAlgorithm,
                new TextEncoder().encode(message),
            )
            return uint8ArrayToHex(signed.signature)
        },
    })
    if ("signature" in outcome) {
        lastPrecommit = { height, round, hash, signature: outcome.signature }
        book.record(
            height,
            round,
            hash,
            getSharedState.publicKeyHex,
            outcome.signature,
        )
    }
    return outcome
}

/** What one committee member decides a precommit with. */
export interface PrecommitSigner {
    identityFile: string
    genesisHash: string | null
    production: boolean
    /** The member's network clock, in seconds. */
    now: number
    /** The member's open prevote for the requested block and round, if any. */
    prevote: PrevoteState | null
    sign: (message: string) => Promise<string>
}

/**
 * The precommit decision of one member, under its lock mutex: the lock
 * rule, the durable lock write, the signature and its signing record, in
 * that order.
 */
export async function precommitUnderLock(
    request: PrecommitRequest,
    member: PrecommitSigner,
): Promise<PrecommitOutcome> {
    const { height, round, hash, pol } = request
    const { prevote, genesisHash, identityFile } = member
    if (
        !prevote ||
        prevote.height !== height ||
        prevote.round !== round ||
        prevote.hash !== hash
    ) {
        return {
            refused: `no open prevote for ${hash} at height ${height} in round ${round}`,
        }
    }
    if (!genesisHash) {
        return { refused: "genesis block hash is not loaded" }
    }
    // A lock in a round far ahead of every honest clock would outrank each
    // honest round after it, so it is never taken, whatever the prevote.
    const ahead = roundAheadRefusal(round, member.now)
    if (ahead) return { refused: ahead }
    const signingRound = { genesisHash, height, timestamp: round, hash }
    const policy = { production: member.production }

    try {
        checkBlockSignature(identityFile, signingRound, policy)
        // The open prevote already implies this within one process; the
        // durable record makes it hold across a restart too
        const later = precommitAfterPrevoteRefusal(
            identityFile,
            genesisHash,
            height,
            round,
        )
        if (later) return { refused: later }

        const current = loadCommitLock(identityFile)
        // Under the fork the record holds only precommits, each signed after
        // its lock was written: a record at this height without the lock
        // means the lock file was lost, and the lock it held still binds us.
        if (
            !current ||
            current.genesisHash !== genesisHash ||
            current.height < height
        ) {
            const record = loadSigningRecord(identityFile)
            if (
                record &&
                record.genesisHash === genesisHash &&
                record.height >= height
            ) {
                const reason =
                    `the signing record holds a precommit at height ${record.height} (round ${record.timestamp}) ` +
                    `but ${commitLockPath(identityFile)} has no lock for height ${height}; the lock file was lost`
                log.error(`[commitLock] Not precommitting ${hash}: ${reason}`)
                return { refused: reason }
            }
        }
        const decision = judgeLock(current, {
            genesisHash,
            height,
            hash,
            round,
        })
        if (decision.action === "refuse") {
            return { refused: decision.reason }
        }
        if (decision.action !== "keep") {
            writeCommitLock(identityFile, {
                genesisHash,
                height,
                hash,
                round,
                pol,
                inputs: prevote.inputs,
                lockedAt: Date.now(),
            })
            if (decision.action === "move") {
                countLockMoved()
                log.warning(
                    `[commitLock] Lock at height ${height} moved from ${decision.from.hash} (round ${decision.from.round}) ` +
                        `to ${hash} (round ${round}) on a later proof of lock`,
                )
            } else {
                countCommitLock()
            }
        }

        const signature = await member.sign(
            precommitMessage(height, round, hash),
        )
        // The signature leaves the process only after this returns
        recordBlockSignature(identityFile, signingRound, policy)
        log.info(
            `[commitLock] Locked on ${hash} at height ${height} and precommitted it in round ${round}`,
        )
        return { signature }
    } catch (e) {
        if (
            e instanceof DoubleSignError ||
            e instanceof SigningRecordError ||
            e instanceof CommitLockError
        ) {
            log.error(`[commitLock] Not precommitting ${hash}: ${e.message}`)
            return { refused: e.message }
        }
        throw e
    }
}

function refuse(
    result: number,
    extra: unknown,
): RPCResponse {
    const response = _.cloneDeep(emptyResponse)
    response.result = result
    response.response = getSharedState.publicKeyHex
    response.extra = extra
    return response
}

/**
 * A committee member holding a proof of lock asks us to precommit its
 * block. Params: [hash, round, height, pol, precommits]. We precommit only
 * the block we prevoted in that round, under the lock rule, and answer
 * with every precommit we hold for it, ours included.
 */
export async function managePrecommitBlockHash(
    sender: string,
    params: unknown[],
    book: PrecommitBook = precommitBook,
): Promise<RPCResponse> {
    const [hash, round, height, pol, precommits] = params ?? []
    if (
        !isBlockHash(hash) ||
        !isRound(round) ||
        typeof height !== "number" ||
        !Number.isSafeInteger(height) ||
        height < 1
    ) {
        return refuse(400, "Malformed precommit request")
    }
    const ahead = roundAheadRefusal(round, getNetworkTimestamp())
    if (ahead) {
        log.warning(
            `[commitLock] Refused a precommit request from ${sender} for ${hash} at height ${height}: ${ahead}`,
        )
        return refuse(409, { message: "Round is ahead of our clock", reason: ahead })
    }
    if (height !== getSharedState.lastBlockNumber + 1) {
        return refuse(409, {
            message: "Not at this height",
            height: getSharedState.lastBlockNumber + 1,
        })
    }
    if (!commitLockActive(height)) {
        return refuse(400, "commitLock is not active at this height")
    }

    let committee: string[]
    try {
        committee = await getBoundCommittee(height - 1)
    } catch (e) {
        log.error(
            `[commitLock] Could not resolve the bound committee of ${height}: ${e instanceof Error ? e.message : String(e)}`,
        )
        return refuse(500, "Could not resolve the bound committee")
    }
    if (!committee.includes(sender)) {
        return refuse(401, "Validator is not in the bound committee")
    }
    if (
        !isSignatureMap(pol) ||
        Object.keys(pol).length > committee.length ||
        (precommits !== undefined &&
            (!isSignatureMap(precommits) ||
                Object.keys(precommits).length > committee.length))
    ) {
        return refuse(400, "Vote map is malformed or larger than the bound committee")
    }

    const verifiedPol = await proofOfLock(height, round, hash, pol, committee)
    if (!verifiedPol) {
        return refuse(400, "No valid proof of lock for this block and round")
    }
    if (precommits !== undefined) {
        await admitPrecommits(height, round, hash, precommits, committee, book)
    }

    const outcome = await lockAndPrecommit(
        { height, round, hash, pol: verifiedPol },
        book,
    )
    if ("refused" in outcome) {
        log.warning(
            `[commitLock] Refused to precommit ${hash} for ${sender} at height ${height} in round ${round}: ${outcome.refused}`,
        )
        return refuse(409, { message: "Precommit refused", reason: outcome.refused })
    }

    const response = _.cloneDeep(emptyResponse)
    response.result = 200
    response.response = getSharedState.publicKeyHex
    response.extra = { precommits: book.precommitsFor(height, round, hash) }
    return response
}

export interface PrecommitTally {
    /** Verified committee precommits for the block in its round. */
    certificate: Record<string, string>
    quorum: number
    committed: CommittedReport[]
}

/** The other committee members, including ones marked offline. */
export function committeePeers(committee: string[]): Peer[] {
    const peerman = PeerManager.getInstance()
    const offline = peerman.getOfflinePeers()
    const selfId = getSharedState.publicKeyHex
    return committee
        .filter(id => id !== selfId)
        .map(id => peerman.getPeer(id) ?? offline[id])
        .filter((p): p is Peer => !!p)
}

/**
 * Send our precommit and the proof of lock to every other committee member
 * and gather the precommits they answer with. Members that already
 * committed the height are reported, as in the prevote exchange.
 *
 * Returns once the book holds a quorum of precommits for the block, or once
 * every member has answered or failed: a dead member must not hold up a
 * block the others already certified. The sends still running carry on in
 * the background, so every member still receives our precommit. A member
 * already marked offline gets a single attempt.
 */
export async function broadcastPrecommit(
    request: PrecommitRequest,
    ownSignature: string,
    committee: string[],
    book: PrecommitBook = precommitBook,
): Promise<PrecommitTally> {
    const { height, round, hash, pol } = request
    const ours = { [getSharedState.publicKeyHex]: ownSignature }
    const committed: CommittedReport[] = []
    const quorum = commitQuorum(committee.length)
    const offline = new Set(
        Object.keys(PeerManager.getInstance().getOfflinePeers()),
    )
    const certified = () =>
        Object.keys(certificateFrom(book, height, round, hash, committee))
            .length >= quorum

    const ask = async (peer: Peer): Promise<void> => {
        let response: RPCResponse
        try {
            response = await peer.longCall(
                {
                    method: "consensus_routine",
                    params: [
                        {
                            method: "precommitBlockHash",
                            params: [hash, round, height, pol, ours],
                        },
                    ],
                },
                true,
                {
                    allowedCodes: [400, 401, 409, COMMITTED_HEIGHT_RESULT],
                    retries: offline.has(peer.identity) ? 1 : 2,
                    sleepTime: 500,
                },
            )
        } catch (e) {
            log.error(
                `[commitLock] precommitBlockHash to ${peer.identity} failed: ${e instanceof Error ? e.message : String(e)}`,
            )
            return
        }

        const committedHash = readCommittedRefusal(response, height)
        if (committedHash !== null) {
            log.warning(
                `[commitLock] ${peer.identity} already committed block ${height} as ${committedHash}`,
            )
            committed.push({ peer, hash: committedHash })
            return
        }
        if (response.result !== 200) {
            log.warning(
                `[commitLock] ${peer.identity} did not precommit ${hash}: result=${response.result} ${JSON.stringify(response.extra)}`,
            )
            return
        }
        const extra = response.extra as { precommits?: unknown } | null
        const incoming = extra?.precommits
        if (
            !isSignatureMap(incoming) ||
            Object.keys(incoming).length > committee.length
        ) {
            log.warning(
                `[commitLock] ${peer.identity} answered with a malformed precommit map`,
            )
            return
        }
        const admitted = await admitPrecommits(
            height,
            round,
            hash,
            incoming,
            committee,
            book,
        )
        if (!admitted.includes(peer.identity)) {
            log.warning(
                `[commitLock] ${peer.identity} answered 200 without a valid precommit of its own`,
            )
        }
    }

    const peers = committeePeers(committee)
    await new Promise<void>(resolve => {
        let pending = peers.length
        if (pending === 0) return resolve()
        for (const peer of peers) {
            ask(peer)
                .catch(e =>
                    log.error(
                        `[commitLock] Precommit exchange with ${peer.identity} failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                )
                .finally(() => {
                    pending--
                    if (pending === 0 || certified()) resolve()
                })
        }
    })

    return {
        certificate: certificateFrom(book, height, round, hash, committee),
        quorum,
        // A copy: answers arriving after we return must not change what
        // the caller already acted on.
        committed: [...committed],
    }
}

/** The committee precommits the book holds for one block in one round. */
export function certificateFrom(
    book: PrecommitBook,
    height: number,
    round: number,
    hash: string,
    committee: string[],
): Record<string, string> {
    const members = new Set(committee)
    const out: Record<string, string> = {}
    for (const [id, sig] of Object.entries(
        book.precommitsFor(height, round, hash),
    )) {
        if (members.has(id)) out[id] = sig
    }
    return out
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetPrecommitState(): void {
    lastPrecommit = null
}
