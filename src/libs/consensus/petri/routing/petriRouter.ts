/**
 * PetriRouter — Petri Consensus Phase 4
 *
 * Routes validated transactions to exactly 2 shard members for inclusion
 * in their mempools. Uses deterministic PRNG (Alea) seeded with the tx hash
 * so all nodes agree on which members handle a given transaction.
 *
 * In Petri, transactions go directly to shard members — not through DTR.
 * The shard members run the ContinuousForge loop and handle delta agreement.
 */

import type { Peer } from "@/libs/peer"
import type { ValidityData } from "@kynesyslabs/demosdk/types"
import Alea from "alea"
import getCommonValidatorSeed from "@/libs/consensus/v2/routines/getCommonValidatorSeed"
import getShard from "@/libs/consensus/v2/routines/getShard"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

/**
 * Select exactly 2 shard members to receive a transaction.
 * Uses Alea PRNG seeded with tx hash for deterministic routing.
 *
 * @param txHash - The transaction hash (used as PRNG seed)
 * @param shard - The current shard members
 * @param membersPerTx - How many members to route to (default 2)
 * @returns Array of selected Peer members
 */
export function selectMembers(
    txHash: string,
    shard: Peer[],
    membersPerTx = 2,
): Peer[] {
    if (shard.length === 0) {
        log.warn("[PetriRouter] Empty shard — cannot route")
        return []
    }

    // Cap at shard size
    const count = Math.min(membersPerTx, shard.length)

    const rng = Alea(txHash)
    const available = [...shard]
    const selected: Peer[] = []

    for (let i = 0; i < count && available.length > 0; i++) {
        const index = Math.floor(rng() * available.length)
        selected.push(available[index])
        available.splice(index, 1)
    }

    return selected
}

/**
 * Get the current shard for routing purposes.
 * Reuses existing getShard() + getCommonValidatorSeed() infrastructure.
 *
 * @returns The current shard members
 */
export async function getCurrentShard(): Promise<Peer[]> {
    const { commonValidatorSeed } = await getCommonValidatorSeed()
    return getShard(commonValidatorSeed)
}

/**
 * Relay a validated transaction to selected shard members.
 * Sends the ValidityData via the existing nodeCall/RELAY_TX RPC method
 * so that shard members add it to their mempools.
 *
 * @param validityData - The validated transaction data
 * @returns Object with relay success status and target member identities
 */
export async function relay(
    validityData: ValidityData,
): Promise<{ success: boolean; targets: string[] }> {
    const txHash = validityData.data.transaction.hash
    const txHashShort = txHash.substring(0, 16)

    const shard = await getCurrentShard()
    const ourKey = getSharedState.publicKeyHex

    // Exclude ourselves from routing targets
    const routableShard = shard.filter(p => p.identity !== ourKey)

    if (routableShard.length === 0) {
        log.warn(`[PetriRouter] No routable shard members for tx ${txHashShort}...`)
        return { success: false, targets: [] }
    }

    const selected = selectMembers(txHash, routableShard)
    const targets = selected.map(p => p.identity)

    log.debug(
        `[PetriRouter] Routing tx ${txHashShort}... to ${selected.length} members`,
    )

    // Relay to selected members using the same RPC pattern as DTR
    const relayPromises = selected.map(async peer => {
        try {
            const response = await peer.longCall(
                {
                    method: "nodeCall",
                    params: [{
                        message: "RELAY_TX",
                        data: [validityData],
                    }],
                },
                true,
                { sleepTime: 250, retries: 2 },
            )
            return response.result === 200
        } catch (error) {
            log.warn(
                `[PetriRouter] Relay to ${peer.identity.substring(0, 16)}... failed: ${error}`,
            )
            return false
        }
    })

    const results = await Promise.all(relayPromises)
    const anySuccess = results.some(Boolean)

    if (!anySuccess) {
        log.warn(`[PetriRouter] All relay attempts failed for tx ${txHashShort}...`)
    }

    return { success: anySuccess, targets }
}
