import { RPCResponse } from "@kynesyslabs/demosdk/types"
import Chain from "src/libs/blockchain/chain"
import { parseStoredGenesisData } from "src/libs/blockchain/genesis/genesisPin"
import { hashGenesisData } from "src/libs/blockchain/genesis/normalizeGenesisForHash"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { answer, failedRead, refusal } from "./finalityShared"

/**
 * The network a client pins, in one read, as this node enforces it:
 *
 * - `chainId`: genesis `properties.id`, the id signatures bind to once
 *   signatureDomain applies; null when the genesis declares none, so this
 *   node binds signatures to no chain.
 * - `genesisHash`: the hash of block 0, which every chain of blocks a proof
 *   walks ends at and which EXPECTED_GENESIS_BLOCK_HASH pins.
 * - `genesisDataHash`: the hash of the genesis data stored in block 0, read
 *   and hashed as the boot check compares it with EXPECTED_GENESIS_HASH.
 *
 * 503 state_not_ready while block 0 is not loaded yet; 500 lookup_failed
 * when it cannot be read or is not the block this node booted on.
 */
export default async function getChainIdentity(): Promise<RPCResponse> {
    try {
        const genesisHash = getSharedState.genesisBlockHash
        const genesisBlock = await Chain.getGenesisBlock()
        if (!genesisHash || !genesisBlock?.content) {
            return refusal(503, "state_not_ready")
        }
        if (genesisBlock.hash !== genesisHash) {
            throw new Error(
                `block 0 in the database is ${genesisBlock.hash}, this node booted on ${genesisHash}`,
            )
        }
        const genesisData = parseStoredGenesisData(
            (genesisBlock.content as { extra?: { genesisData?: unknown } }).extra?.genesisData ?? null,
        )
        return answer({
            chainId: getSharedState.chainId ?? null,
            genesisHash,
            genesisDataHash: hashGenesisData(genesisData),
        })
    } catch (error) {
        log.error("[getChainIdentity] Error reading the chain identity:", error)
        return failedRead(error)
    }
}
