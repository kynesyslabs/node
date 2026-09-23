import type { Block } from "@kynesyslabs/demosdk/types"

import GCR from "src/libs/blockchain/gcr/gcr"
import type { Validators } from "src/model/entities/Validators"
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
import { BLOCKS_MAX_BYTES, HEIGHTS_MAX_BYTES } from "./topics"
import { recordVerdict } from "./metrics"

export type GossipVerdict = "accept" | "reject" | "ignore"

const BLOCK_HEIGHT_WINDOW = 2
const SEQ_LRU_MAX = 2048

// Acceptance gate is the full staked set at local head, NOT the
// block-embedded peerlist — a briefly-offline validator must be able to
// re-announce itself.
let stakedSet = new Set<string>()
let stakedSetHeight = -1
let stakedSetRefresh: Promise<void> | null = null

async function refreshStakedSet(): Promise<void> {
    const head = getSharedState.lastBlockNumber
    if (head === stakedSetHeight) return
    if (stakedSetRefresh) return stakedSetRefresh

    stakedSetRefresh = (async () => {
        try {
            const validators = (await GCR.getGCRValidatorsAtBlock(
                head,
            )) as Validators[]
            stakedSet = new Set(
                validators
                    .map(v => v.address)
                    .filter((a): a is string => a !== null)
                    .map(a => a.toLowerCase()),
            )
            stakedSetHeight = head
        } catch (e) {
            log.warning(
                `[GOSSIP] staked-set refresh failed at head ${head}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        } finally {
            stakedSetRefresh = null
        }
    })()
    return stakedSetRefresh
}

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

    await refreshStakedSet()
    if (!stakedSet.has(record.pubkey.toLowerCase())) {
        log.debug(
            `[GOSSIP] heights reject: ${record.pubkey} not in staked set (${stakedSet.size} entries at height ${stakedSetHeight})`,
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
