// FIXME Add endpoints for server_rpc.ts to handle L2PS transactions with this module
// FIXME Add L2PS private mempool logic with L2PS mempool/txs hash in the global GCR for integrity
// FIXME Add L2PS Sync in Sync.ts (I guess)

import { UnifiedCrypto } from "@kynesyslabs/demosdk/encryption"
import * as forge from "node-forge"
import fs from "fs"
import path from "path"
import {
    L2PS,
    L2PSConfig,
    L2PSEncryptedPayload,
} from "@kynesyslabs/demosdk/l2ps"
import { L2PSTransaction, Transaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"

interface L2PSNodeConfig {
    uid: string
    name: string
    description?: string
    config: {
        created_at_block: number
        known_rpcs: string[]
        network_params?: {
            max_tx_per_block?: number
            block_time_ms?: number
            consensus_threshold?: number
        }
    }
    keys: {
        private_key_path: string
        iv_path: string
    }
    enabled: boolean
    auto_start?: boolean
}

export default class ParallelNetworks {
    private static instance: ParallelNetworks
    private l2pses: Map<string, L2PS> = new Map()
    private configs: Map<string, L2PSNodeConfig> = new Map()

    private constructor() {}

    static getInstance(): ParallelNetworks {
        if (!ParallelNetworks.instance) {
            ParallelNetworks.instance = new ParallelNetworks()
        }
        return ParallelNetworks.instance
    }

    async loadL2PS(uid: string): Promise<L2PS> {
        if (this.l2pses.has(uid)) {
            return this.l2pses.get(uid) as L2PS
        }

        const configPath = path.join(
            process.cwd(),
            "data",
            "l2ps",
            uid,
            "config.json",
        )
        if (!fs.existsSync(configPath)) {
            throw new Error(`L2PS config file not found: ${configPath}`)
        }

        const nodeConfig: L2PSNodeConfig = JSON.parse(
            fs.readFileSync(configPath, "utf8"),
        )
        if (!nodeConfig.uid || !nodeConfig.enabled) {
            throw new Error(`L2PS config invalid or disabled: ${uid}`)
        }

        const privateKeyPath = path.resolve(
            process.cwd(),
            nodeConfig.keys.private_key_path,
        )
        const ivPath = path.resolve(process.cwd(), nodeConfig.keys.iv_path)

        if (!fs.existsSync(privateKeyPath) || !fs.existsSync(ivPath)) {
            throw new Error(`L2PS key files not found for ${uid}`)
        }

        const privateKey = fs.readFileSync(privateKeyPath, "utf8").trim()
        const iv = fs.readFileSync(ivPath, "utf8").trim()

        const l2ps = await L2PS.create(privateKey, iv)
        const l2psConfig: L2PSConfig = {
            uid: nodeConfig.uid,
            config: nodeConfig.config,
        }
        l2ps.setConfig(l2psConfig)

        this.l2pses.set(uid, l2ps)
        this.configs.set(uid, nodeConfig)

        return l2ps
    }

    async getL2PS(uid: string): Promise<L2PS | undefined> {
        try {
            return await this.loadL2PS(uid)
        } catch (error) {
            console.error(`Failed to load L2PS ${uid}:`, error)
            return undefined
        }
    }

    getAllL2PSIds(): string[] {
        return Array.from(this.l2pses.keys())
    }

    async loadAllL2PS(): Promise<string[]> {
        var l2psJoinedUids = []
        const l2psDir = path.join(process.cwd(), "data", "l2ps")
        if (!fs.existsSync(l2psDir)) {
            console.warn("L2PS data directory not found, creating...")
            fs.mkdirSync(l2psDir, { recursive: true })
            return
        }

        const dirs = fs
            .readdirSync(l2psDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)

        for (const uid of dirs) {
            try {
                await this.loadL2PS(uid)
                l2psJoinedUids.push(uid)
                console.log(`Loaded L2PS: ${uid}`)
            } catch (error) {
                console.error(`Failed to load L2PS ${uid}:`, error)
            }
        }
        getSharedState.l2psJoinedUids = l2psJoinedUids
        return l2psJoinedUids
    }

    /**
     * Encrypts a transaction for the specified L2PS network.
     * Returns a new Transaction object containing the encrypted data.
     * 
     * @param uid - The L2PS network UID
     * @param tx - The original transaction to encrypt
     * @param senderIdentity - Optional sender identity for the encrypted transaction wrapper
     * @returns Promise resolving to an encrypted Transaction object
     */
    async encryptTransaction(
        uid: string,
        tx: Transaction,
        senderIdentity?: any,
    ): Promise<Transaction> {
        const l2ps = await this.loadL2PS(uid)
        return l2ps.encryptTx(tx, senderIdentity)
        // TODO: Sign with node private key
    }

    /**
     * Decrypts an L2PS encrypted transaction.
     * 
     * @param uid - The L2PS network UID
     * @param encryptedTx - The encrypted Transaction object
     * @returns Promise resolving to the original decrypted Transaction
     */
    async decryptTransaction(
        uid: string,
        encryptedTx: L2PSTransaction,
    ): Promise<Transaction> {
        const l2ps = await this.loadL2PS(uid)
        return l2ps.decryptTx(encryptedTx)
        // TODO: Verify signature of the decrypted transaction
    }

    /**
     * Checks if a transaction is an L2PS encrypted transaction.
     * 
     * @param tx - The transaction to check
     * @returns True if the transaction is of type l2psEncryptedTx
     */
    isL2PSTransaction(tx: L2PSTransaction): boolean {
        return tx.content.type === "l2psEncryptedTx"
    }

    /**
     * Extracts the L2PS UID from an encrypted transaction.
     * 
     * @param tx - The encrypted transaction
     * @returns The L2PS UID if valid, undefined otherwise
     */
    getL2PSUidFromTransaction(tx: L2PSTransaction): string | undefined {
        if (!this.isL2PSTransaction(tx)) {
            return undefined
        }

        try {
            const [dataType, payload] = tx.content.data
            if (dataType === "l2psEncryptedTx") {
                const encryptedPayload = payload as L2PSEncryptedPayload
                return encryptedPayload.l2ps_uid
            }
        } catch (error) {
            console.error("Error extracting L2PS UID from transaction:", error)
        }

        return undefined
    }

    /**
     * TODO: Process an L2PS transaction in the mempool.
     * This function will be called when an L2PS encrypted transaction is received.
     * 
     * @param tx - The L2PS encrypted transaction to process
     * @returns Promise resolving to processing result or error
     */
    async processL2PSTransaction(tx: L2PSTransaction): Promise<{
        success: boolean
        error?: string
        l2ps_uid?: string
        processed?: boolean
    }> {
        // Validate that this is an L2PS transaction
        if (!this.isL2PSTransaction(tx)) {
            return {
                success: false,
                error: "Transaction is not of type l2psEncryptedTx",
            }
        }

        try {
            // Extract L2PS UID
            const l2psUid = this.getL2PSUidFromTransaction(tx)
            if (!l2psUid) {
                return {
                    success: false,
                    error: "Could not extract L2PS UID from transaction",
                }
            }

            // Check if we have this L2PS loaded
            if (!this.isL2PSLoaded(l2psUid)) {
                // Try to load the L2PS
                const l2ps = await this.getL2PS(l2psUid)
                if (!l2ps) {
                    return {
                        success: false,
                        error: `L2PS ${l2psUid} not available on this node`,
                        l2ps_uid: l2psUid,
                    }
                }
            }

            // TODO: Implement actual processing logic
            // This could include:
            // 1. Validating the transaction signature
            // 2. Adding to L2PS-specific mempool
            // 3. Broadcasting to L2PS network participants
            // 4. Scheduling for inclusion in next L2PS block
            
            console.log(`TODO: Process L2PS transaction for network ${l2psUid}`)
            console.log(`Transaction hash: ${tx.hash}`)
            
            return {
                success: true,
                l2ps_uid: l2psUid,
                processed: false, // Set to true when actual processing is implemented
            }
        } catch (error: any) {
            return {
                success: false,
                error: `Failed to process L2PS transaction: ${error.message}`,
            }
        }
    }

    getL2PSConfig(uid: string): L2PSNodeConfig | undefined {
        return this.configs.get(uid)
    }

    isL2PSLoaded(uid: string): boolean {
        return this.l2pses.has(uid)
    }

    unloadL2PS(uid: string): boolean {
        this.configs.delete(uid)
        return this.l2pses.delete(uid)
    }
}
