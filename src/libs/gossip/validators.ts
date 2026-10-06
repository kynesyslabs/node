import type { Block } from "@kynesyslabs/demosdk/types"

import {
    getStakedSet,
    getStakedSetHeight,
    isStaked,
} from "src/libs/consensus/stakedSet"
import Hashing from "src/libs/crypto/hashing"
import { serializeBlockContent } from "@/forks"
import { verifyBlock } from "src/libs/blockchain/validation/verifyBlock"
import { getSharedState } from "@/utilities/sharedState"
import log from "src/utilities/logger"

import {
    HeightsRecord,
    isHeightsRecordShape,
    verifyHeightsRecord,
} from "./records"
import {
    BLOCKS_MAX_BYTES,
    HEIGHTS_MAX_BYTES,
    TXS_GLOBAL_BURST,
    TXS_GLOBAL_RATE_PER_SEC,
    TXS_MAX_BYTES,
    TXS_PUBLISHER_BURST,
    TXS_PUBLISHER_BYTES_BURST,
    TXS_PUBLISHER_BYTES_PER_SEC,
    TXS_PUBLISHER_RATE_PER_SEC,
} from "./topics"
import { countTxRateLimited, recordVerdict } from "./metrics"
import { TxRateLimiter } from "./rateLimit"
import type { ValidityData } from "@kynesyslabs/demosdk/types"
import { verifyValidityDataSignature } from "src/libs/blockchain/validation/validityData"

export type GossipVerdict = "accept" | "reject" | "ignore"

const BLOCK_HEIGHT_WINDOW = 2
const SEQ_LRU_MAX = 2048

// Acceptance gate is the full staked set at local head, NOT the
// block-embedded peerlist — a briefly-offline validator must be able to
// re-announce itself. See src/libs/consensus/stakedSet.ts.
const lastSeq = new Map<string, number>()

function seqIsFresh(pubkey: string, seq: number): boolean {
    const prev = lastSeq.get(pubkey)
    if (prev !== undefined && seq <= prev) return false
    lastSeq.set(pubkey, seq)
    if (lastSeq.size > SEQ_LRU_MAX) {
        lastSeq.delete(lastSeq.keys().next().value)
    }
    return true
}

export interface HeightsValidation {
    result: GossipVerdict
    record?: HeightsRecord
}

export async function validateHeightsMessage(
    data: Uint8Array,
): Promise<HeightsValidation> {
    if (data.length > HEIGHTS_MAX_BYTES) {
        log.debug(`[GOSSIP] heights reject: oversized (${data.length} bytes)`)
        recordVerdict("heights", "reject")
        return { result: "reject" }
    }

    let record: unknown
    try {
        record = JSON.parse(new TextDecoder().decode(data))
    } catch {
        log.debug("[GOSSIP] heights reject: payload is not JSON")
        recordVerdict("heights", "reject")
        return { result: "reject" }
    }
    if (!isHeightsRecordShape(record)) {
        log.debug("[GOSSIP] heights reject: malformed record shape")
        recordVerdict("heights", "reject")
        return { result: "reject" }
    }

    if (!(await isStaked(record.pubkey))) {
        log.debug(
            `[GOSSIP] heights reject: ${record.pubkey} not in staked set (${(await getStakedSet()).size} entries at height ${getStakedSetHeight()})`,
        )
        recordVerdict("heights", "reject")
        return { result: "reject" }
    }

    if (!seqIsFresh(record.pubkey, record.seq)) {
        log.debug(
            `[GOSSIP] heights ignore: stale seq ${record.seq} from ${record.pubkey}`,
        )
        recordVerdict("heights", "ignore")
        return { result: "ignore" }
    }

    if (!(await verifyHeightsRecord(record))) {
        log.debug(
            `[GOSSIP] heights reject: bad signature from ${record.pubkey}`,
        )
        recordVerdict("heights", "reject")
        return { result: "reject" }
    }

    log.debug(
        `[GOSSIP] heights accept: ${record.pubkey} at height ${record.height} (seq ${record.seq})`,
    )
    recordVerdict("heights", "accept")
    return { result: "accept", record }
}

export interface BlockValidation {
    result: GossipVerdict
    block?: Block
}

export async function validateBlockMessage(
    data: Uint8Array,
): Promise<BlockValidation> {
    if (data.length > BLOCKS_MAX_BYTES) {
        log.debug(`[GOSSIP] block reject: oversized (${data.length} bytes)`)
        recordVerdict("blocks", "reject")
        return { result: "reject" }
    }

    let block: Block
    try {
        block = JSON.parse(new TextDecoder().decode(data))
    } catch {
        log.debug("[GOSSIP] block reject: payload is not JSON")
        recordVerdict("blocks", "reject")
        return { result: "reject" }
    }
    if (
        block == null ||
        typeof block.number !== "number" ||
        !Number.isInteger(block.number) ||
        block.number < 0 ||
        typeof block.hash !== "string" ||
        block.content == null ||
        block.validation_data?.signatures == null
    ) {
        log.debug("[GOSSIP] block reject: malformed block shape")
        recordVerdict("blocks", "reject")
        return { result: "reject" }
    }

    const head = getSharedState.lastBlockNumber
    if (Math.abs(block.number - head) > BLOCK_HEIGHT_WINDOW) {
        log.debug(
            `[GOSSIP] block ignore: ${block.number} outside window around head ${head}`,
        )
        recordVerdict("blocks", "ignore")
        return { result: "ignore" }
    }

    let expectedHash: string
    try {
        expectedHash = Hashing.sha256(
            serializeBlockContent(block.content, block.number),
        )
    } catch {
        recordVerdict("blocks", "reject")
        return { result: "reject" }
    }
    if (expectedHash !== block.hash) {
        log.debug(
            `[GOSSIP] block reject: hash mismatch (claimed ${block.hash}, recomputed ${expectedHash})`,
        )
        recordVerdict("blocks", "reject")
        return { result: "reject" }
    }

    // Full quorum verification needs the parent block; only possible for
    // heights we can anchor locally. `ignore` (never `reject`) when the
    // failure is our own lag.
    if (block.number > head + 1) {
        log.debug(
            `[GOSSIP] block ignore: ${block.number} ahead of head ${head}, cannot verify quorum yet`,
        )
        recordVerdict("blocks", "ignore")
        return { result: "ignore" }
    }

    try {
        const verdict = await verifyBlock(block)
        if (!verdict.valid) {
            if (verdict.reason?.includes("not found")) {
                log.debug(
                    `[GOSSIP] block ignore: ${verdict.reason} (local lag)`,
                )
                recordVerdict("blocks", "ignore")
                return { result: "ignore" }
            }
            log.warning(
                `[GOSSIP] rejecting block ${block.number}: ${verdict.reason}`,
            )
            recordVerdict("blocks", "reject")
            return { result: "reject" }
        }
    } catch (e) {
        log.warning(
            `[GOSSIP] block ${block.number} verification threw: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        recordVerdict("blocks", "ignore")
        return { result: "ignore" }
    }

    log.debug(
        `[GOSSIP] block accept: ${block.number} (${block.hash}), quorum verified`,
    )
    recordVerdict("blocks", "accept")
    return { result: "accept", block }
}

// ── demos/txs/1 ─────────────────────────────────────────────────────────

const txRateLimiter = new TxRateLimiter({
    publisherMessages: {
        ratePerSec: TXS_PUBLISHER_RATE_PER_SEC,
        burst: TXS_PUBLISHER_BURST,
    },
    publisherBytes: {
        ratePerSec: TXS_PUBLISHER_BYTES_PER_SEC,
        burst: TXS_PUBLISHER_BYTES_BURST,
    },
    globalMessages: {
        ratePerSec: TXS_GLOBAL_RATE_PER_SEC,
        burst: TXS_GLOBAL_BURST,
    },
})

export function isValidityDataShape(x: unknown): x is ValidityData {
    if (x === null || typeof x !== "object") return false
    const vd = x as Record<string, unknown>
    const data = vd.data as Record<string, unknown> | undefined
    const sig = vd.signature as Record<string, unknown> | undefined
    const key = vd.rpc_public_key as Record<string, unknown> | undefined
    return (
        data !== undefined &&
        typeof data === "object" &&
        data !== null &&
        typeof data.reference_block === "number" &&
        data.transaction !== null &&
        typeof data.transaction === "object" &&
        typeof (data.transaction as { hash?: unknown }).hash === "string" &&
        sig !== undefined &&
        typeof sig?.data === "string" &&
        typeof sig?.type === "string" &&
        key !== undefined &&
        typeof key?.data === "string" &&
        typeof key?.type === "string"
    )
}

export interface TxValidation {
    result: GossipVerdict
    validityData?: ValidityData
}

/**
 * Gate for gossiped transactions: size, shape, signing algorithm, a staked
 * publisher, its rate budget, and the publisher's signature over the
 * envelope. Everything about the transaction itself is checked by the
 * mempool ingest step that follows an accept.
 *
 * Over-budget messages are `ignore`, not `reject`, so gossipsub does not
 * penalise an honest but busy publisher.
 */
export async function validateTxMessage(
    data: Uint8Array,
): Promise<TxValidation> {
    if (data.length > TXS_MAX_BYTES) {
        log.debug(`[GOSSIP] tx reject: oversized (${data.length} bytes)`)
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(new TextDecoder().decode(data))
    } catch {
        log.debug("[GOSSIP] tx reject: payload is not JSON")
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    if (!isValidityDataShape(parsed)) {
        log.debug("[GOSSIP] tx reject: malformed validity data shape")
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    const validityData = parsed
    const publisher = validityData.rpc_public_key.data

    if (validityData.rpc_public_key.type !== getSharedState.signingAlgorithm) {
        log.debug(
            `[GOSSIP] tx reject: publisher ${publisher} uses ${validityData.rpc_public_key.type}, we use ${getSharedState.signingAlgorithm}`,
        )
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    if (!(await isStaked(publisher))) {
        log.debug(
            `[GOSSIP] tx reject: publisher ${publisher} not in staked set at height ${getStakedSetHeight()}`,
        )
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    const budget = txRateLimiter.admit(publisher, data.length)
    if (budget !== "ok") {
        log.debug(`[GOSSIP] tx ignore: ${budget} for publisher ${publisher}`)
        countTxRateLimited(budget)
        recordVerdict("txs", "ignore")
        return { result: "ignore" }
    }
    if (!(await verifyValidityDataSignature(validityData))) {
        log.debug(`[GOSSIP] tx reject: bad envelope signature from ${publisher}`)
        recordVerdict("txs", "reject")
        return { result: "reject" }
    }
    recordVerdict("txs", "accept")
    return { result: "accept", validityData }
}
