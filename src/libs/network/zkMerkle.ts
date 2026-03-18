import log from "src/utilities/logger"
import Datasource from "@/model/datasource"
import { MerkleTreeManager } from "@/features/zk/merkle/MerkleTreeManager"
import { getCurrentMerkleTreeState } from "@/features/zk/merkle/updateMerkleTreeAfterBlock"
import { UsedNullifier } from "@/model/entities/GCRv2/UsedNullifier"
import { jsonResponse } from "./bunServer"
import type { BunServer } from "./bunServer"

// ZK Merkle tree configuration constants
const ZK_MERKLE_TREE_DEPTH = 20
const ZK_MERKLE_TREE_ID = "global"

// Singleton MerkleTreeManager instance
let globalMerkleManager: MerkleTreeManager | null = null
let initializationPromise: Promise<MerkleTreeManager> | null = null
let lastInitializationError: { timestamp: number; error: Error } | null = null
const INITIALIZATION_BACKOFF_MS = 5000
const INIT_TIMEOUT_MS = 30000

/**
 * Get or create the global MerkleTreeManager singleton instance.
 * Lazily initializes on first call to avoid startup overhead.
 * Thread-safe: Prevents concurrent initialization with promise guard.
 */
export async function getMerkleTreeManager(): Promise<MerkleTreeManager> {
    if (globalMerkleManager) {
        return globalMerkleManager
    }

    if (initializationPromise) {
        return await initializationPromise
    }

    if (lastInitializationError) {
        const timeSinceError = Date.now() - lastInitializationError.timestamp
        if (timeSinceError < INITIALIZATION_BACKOFF_MS) {
            log.warn("MerkleTreeManager initialization in backoff period")
            throw new Error(
                "MerkleTreeManager initialization temporarily unavailable. Please retry shortly.",
            )
        }
        lastInitializationError = null
    }

    initializationPromise = Promise.race([
        (async () => {
            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const manager = new MerkleTreeManager(
                dataSource,
                ZK_MERKLE_TREE_DEPTH,
                ZK_MERKLE_TREE_ID,
            )
            await manager.initialize()
            log.info("✅ Global MerkleTreeManager initialized")
            globalMerkleManager = manager
            return globalMerkleManager
        })(),
        new Promise<MerkleTreeManager>((_, reject) =>
            setTimeout(() => reject(new Error("Initialization timeout")), INIT_TIMEOUT_MS),
        ),
    ])

    try {
        const result = await initializationPromise
        initializationPromise = null
        return result
    } catch (error) {
        initializationPromise = null
        lastInitializationError = {
            timestamp: Date.now(),
            error: error instanceof Error ? error : new Error(String(error)),
        }
        log.error("MerkleTreeManager initialization failed:", error)
        throw error
    }
}

export async function getFreshMerkleTreeManager(): Promise<MerkleTreeManager> {
    const manager = await getMerkleTreeManager()
    const db = await Datasource.getInstance()
    const dataSource = db.getDataSource()
    const currentState = await getCurrentMerkleTreeState(dataSource)

    if (!currentState) {
        return manager
    }

    const stats = manager.getStats()
    const isStale =
        stats.root !== currentState.rootHash ||
        stats.leafCount !== currentState.leafCount

    if (!isStale) {
        return manager
    }

    log.warn(
        `[ZK RPC] Refreshing stale MerkleTreeManager singleton: in-memory leafCount=${stats.leafCount}, db leafCount=${currentState.leafCount}`,
    )

    globalMerkleManager = null
    initializationPromise = null
    lastInitializationError = null

    return await getMerkleTreeManager()
}

/**
 * Register ZK HTTP GET routes on the server.
 */
export function registerZkRoutes(server: BunServer): void {
    server.get("/zk/merkle-root", async () => {
        try {
            const manager = await getFreshMerkleTreeManager()
            const stats = manager.getStats()
            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const currentState = await getCurrentMerkleTreeState(dataSource)

            return jsonResponse({
                rootHash: currentState?.rootHash || stats.root,
                blockNumber: currentState?.blockNumber || 0,
                leafCount: currentState?.leafCount ?? stats.leafCount,
            })
        } catch (error) {
            log.error("[ZK RPC] Error getting Merkle root:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })

    server.get("/zk/merkle/proof/:commitment", async req => {
        try {
            const commitment = req.params.commitment

            if (!commitment) {
                return jsonResponse({ error: "Commitment hash required" }, 400)
            }

            if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
                return jsonResponse({ error: "Invalid commitment format" }, 400)
            }

            const merkleManager = await getFreshMerkleTreeManager()
            const proof = await merkleManager.getProofForCommitment(commitment)

            if (!proof) {
                return jsonResponse(
                    { error: "Commitment not found in Merkle tree" },
                    404,
                )
            }

            return jsonResponse({
                commitment: commitment,
                proof: {
                    siblings: proof.siblings,
                    pathIndices: proof.pathIndices,
                    root: proof.root,
                    leafIndex: proof.leafIndex,
                },
            })
        } catch (error) {
            log.error("[ZK RPC] Error getting Merkle proof:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })

    server.get("/zk/nullifier/:hash", async req => {
        try {
            const nullifierHash = req.params.hash

            if (!nullifierHash) {
                return jsonResponse({ error: "Nullifier hash required" }, 400)
            }

            if (!/^0x[0-9a-fA-F]{64}$/.test(nullifierHash)) {
                return jsonResponse({ error: "Invalid nullifier hash format" }, 400)
            }

            const db = await Datasource.getInstance()
            const dataSource = db.getDataSource()
            const nullifierRepo = dataSource.getRepository(UsedNullifier)

            const nullifier = await nullifierRepo.findOne({
                where: { nullifierHash },
            })

            if (!nullifier) {
                return jsonResponse({
                    used: false,
                    nullifierHash,
                })
            }

            return jsonResponse({
                used: true,
                nullifierHash,
                blockNumber: nullifier.blockNumber,
                transactionHash: nullifier.transactionHash,
            })
        } catch (error) {
            log.error("[ZK RPC] Error checking nullifier:", error)
            return jsonResponse({ error: "Internal server error" }, 500)
        }
    })
}
