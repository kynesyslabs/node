import Chain from "@/libs/blockchain/chain"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

/**
 * Shard size is a static consensus constant committed in block 0.
 *
 * It lives at `properties.shardSize` in `data/genesis.json`, which block 0
 * embeds verbatim in `content.extra.genesisData` and hashes. Every peer
 * therefore agrees on it by construction: a node with a different value
 * has a different genesis hash and is on a different network. Changing it
 * is a hard fork that restarts the chain from a snapshot.
 *
 * At boot the value is read back from the stored block 0, never from the
 * file, so editing the file on a running node cannot move the quorum.
 */

/** Smallest committee that can meet a 2/3 + 1 quorum with any dissent. */
export const SHARD_SIZE_MIN = 3
export const SHARD_SIZE_MAX = 100

export class GenesisShardSizeError extends Error {
    constructor(message: string) {
        super(`[GENESIS] properties.shardSize: ${message}`)
        this.name = "GenesisShardSizeError"
    }
}

/** Validate and return `properties.shardSize` from a parsed genesis payload. */
export function readGenesisShardSize(genesisData: unknown): number {
    if (genesisData === null || typeof genesisData !== "object") {
        throw new GenesisShardSizeError("genesis data is not an object")
    }
    const properties = (genesisData as { properties?: unknown }).properties
    if (properties === null || typeof properties !== "object") {
        throw new GenesisShardSizeError("genesis has no `properties` object")
    }
    const raw = (properties as { shardSize?: unknown }).shardSize
    if (raw === undefined) {
        throw new GenesisShardSizeError(
            "missing; this consensus constant must be set in genesis",
        )
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new GenesisShardSizeError(
            `must be an integer, got ${JSON.stringify(raw)}`,
        )
    }
    if (raw < SHARD_SIZE_MIN || raw > SHARD_SIZE_MAX) {
        throw new GenesisShardSizeError(
            `must be within [${SHARD_SIZE_MIN}, ${SHARD_SIZE_MAX}], got ${raw}`,
        )
    }
    return raw
}

/**
 * Read shard size from the stored block 0 and pin it on shared state.
 * Throws when block 0 is absent or carries no valid value, so the node
 * never runs consensus with an unknown quorum.
 */
export async function loadShardSizeFromGenesisBlock(): Promise<number> {
    const genesisBlock = await Chain.getGenesisBlock()
    if (!genesisBlock) {
        throw new GenesisShardSizeError("block 0 not found in the database")
    }
    let genesisData: unknown = (
        genesisBlock.content as { extra?: { genesisData?: unknown } }
    ).extra?.genesisData
    if (typeof genesisData === "string") {
        try {
            genesisData = JSON.parse(genesisData)
        } catch {
            throw new GenesisShardSizeError(
                "block 0 carries corrupt genesis data",
            )
        }
    }
    const shardSize = readGenesisShardSize(genesisData)
    getSharedState.setShardSizeFromGenesis(shardSize)
    log.info(`[GENESIS] shardSize=${shardSize} (committed in block 0)`)
    return shardSize
}
