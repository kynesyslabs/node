import { ucrypto, hexToUint8Array, uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import * as forge from "node-forge"
import fs from "node:fs"
import path from "node:path"
import {
    L2PS,
    L2PSConfig,
    L2PSEncryptedPayload,
} from "@kynesyslabs/demosdk/l2ps"
import { Transaction, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import type { L2PSTransaction } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { getErrorMessage } from "@/utilities/errorMessage"
import TxValidatorPool from "../blockchain/validation/txValidatorPool"

/**
 * Configuration interface for an L2PS node.
 * @interface L2PSNodeConfig
 */
interface L2PSNodeConfig {
    /** Unique identifier for the L2PS node */
    uid: string
    /** Display name of the L2PS node */
    name: string
    /** Optional description of the L2PS node */
    description?: string
    /** Configuration parameters for the L2PS node */
    config: {
        /** Block number when the L2PS node was created */
        created_at_block: number
        /** List of known RPC endpoints for the network */
        known_rpcs: string[]
        /** Optional network-specific parameters */
        network_params?: {
            /** Maximum number of transactions per block */
            max_tx_per_block?: number
            /** Block time in milliseconds */
            block_time_ms?: number
            /** Consensus threshold for block validation */
            consensus_threshold?: number
        }
    }
    /** Key configuration for encryption/decryption */
    keys: {
        /** Path to the private key file */
        private_key_path: string
        /** Path to the initialization vector file */
        iv_path: string
    }
    /** Whether the L2PS node is enabled */
    enabled: boolean
    /** Whether the L2PS node should start automatically */
    auto_start?: boolean
}

function hexFileToBytes(value: string, label: string): string {
    if (!value) {
        throw new Error(`${label} is empty`)
    }

    const cleaned = value.trim().replace(/^0x/, "").replaceAll(/\s+/g, "")

    if (cleaned.length === 0) {
        throw new Error(`${label} is empty`)
    }

    if (cleaned.length % 2 !== 0) {
        throw new Error(`${label} hex length must be even`)
    }

    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
        throw new Error(`${label} contains non-hex characters`)
    }

    return forge.util.hexToBytes(cleaned)
}

/**
 * Manages parallel L2PS (Layer 2 Private System) networks.
 * This class implements the Singleton pattern to ensure only one instance exists.
 * It handles loading, managing, and processing L2PS networks and their transactions.
 */
export default class ParallelNetworks {
    private static instance: ParallelNetworks
    private readonly l2pses: Map<string, L2PS> = new Map()
    private readonly configs: Map<string, L2PSNodeConfig> = new Map()
    /** Promise lock to prevent concurrent loadL2PS race conditions */
    private readonly loadingPromises: Map<string, Promise<L2PS>> = new Map()

    private constructor() { }

    /**
     * Gets the singleton instance of ParallelNetworks.
     * @returns {ParallelNetworks} The singleton instance
     */
    static getInstance(): ParallelNetworks {
        if (!ParallelNetworks.instance) {
            ParallelNetworks.instance = new ParallelNetworks()
        }
        return ParallelNetworks.instance
    }

    /**
     * Loads an L2PS network configuration and initializes it.
     * @param {string} uid - The unique identifier of the L2PS network
     * @returns {Promise<L2PS>} The initialized L2PS instance
     * @throws {Error} If the configuration is invalid or required files are missing
     */
    async loadL2PS(uid: string): Promise<L2PS> {
        // Validate uid to prevent path traversal attacks
        if (!uid || !/^[A-Za-z0-9_-]+$/.test(uid)) {
            throw new Error(`Invalid L2PS uid: ${uid}`)
        }

        if (this.l2pses.has(uid)) {
            return this.l2pses.get(uid)!
        }

        // Check if already loading to prevent race conditions
        const existingPromise = this.loadingPromises.get(uid)
        if (existingPromise !== undefined) {
            return existingPromise
        }

        const loadPromise = this.loadL2PSInternal(uid)
        this.loadingPromises.set(uid, loadPromise)

        try {
            const l2ps = await loadPromise
            return l2ps
        } finally {
            this.loadingPromises.delete(uid)
        }
    }

    /**
     * Internal method to load L2PS configuration and initialize instance
     * @param {string} uid - The unique identifier of the L2PS network
     * @returns {Promise<L2PS>} The initialized L2PS instance
     * @private
     */
    private async loadL2PSInternal(uid: string): Promise<L2PS> {
        // Verify resolved path is within expected directory
        const basePath = path.resolve(process.cwd(), "data", "l2ps")
        const configPath = path.resolve(basePath, uid, "config.json")

        if (!configPath.startsWith(basePath)) {
            throw new Error(`Path traversal detected in uid: ${uid}`)
        }
        if (!fs.existsSync(configPath)) {
            throw new Error(`L2PS config file not found: ${configPath}`)
        }

        let nodeConfig: L2PSNodeConfig
        try {
            nodeConfig = JSON.parse(
                fs.readFileSync(configPath, "utf8"),
            )
        } catch (error) {
            const message = getErrorMessage(error)
            throw new Error(`Failed to parse L2PS config for ${uid}: ${message}`)
        }

        if (!nodeConfig.uid || !nodeConfig.enabled) {
            throw new Error(`L2PS config invalid or disabled: ${uid}`)
        }

        // Validate nodeConfig.keys exists before accessing
        if (!nodeConfig.keys?.private_key_path || !nodeConfig.keys?.iv_path) {
            throw new Error(`L2PS config missing required keys for ${uid}`)
        }

        const privateKeyPath = path.resolve(
            process.cwd(),
            nodeConfig.keys.private_key_path,
        )
        const ivPath = path.resolve(process.cwd(), nodeConfig.keys.iv_path)

        // REVIEW: FIX - Prevent path traversal (must be within project root)
        const projectRoot = process.cwd()
        if (!privateKeyPath.startsWith(projectRoot) || !ivPath.startsWith(projectRoot)) {
            throw new Error(`Path traversal detected: Key files must be within project directory (${uid})`)
        }

        if (!fs.existsSync(privateKeyPath) || !fs.existsSync(ivPath)) {
            throw new Error(`L2PS key files not found for ${uid}`)
        }

        const privateKeyHex = fs.readFileSync(privateKeyPath, "utf8").trim()
        const ivHex = fs.readFileSync(ivPath, "utf8").trim()

        const privateKeyBytes = hexFileToBytes(privateKeyHex, `${uid} private key`)
        const ivBytes = hexFileToBytes(ivHex, `${uid} IV`)

        const l2ps = await L2PS.create(privateKeyBytes, ivBytes)
        const l2psConfig: L2PSConfig = {
            uid: nodeConfig.uid,
            config: nodeConfig.config,
        }
        l2ps.setConfig(l2psConfig)

        this.l2pses.set(uid, l2ps)
        this.configs.set(uid, nodeConfig)

        return l2ps
    }

    /**
     * Attempts to get an L2PS instance, loading it if necessary.
     * @param {string} uid - The unique identifier of the L2PS network
     * @returns {Promise<L2PS | undefined>} The L2PS instance if successful, undefined otherwise
     */
    async getL2PS(uid: string): Promise<L2PS | undefined> {
        try {
            return await this.loadL2PS(uid)
        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS] Failed to load L2PS ${uid}: ${message}`)
            return undefined
        }
    }

    /**
     * Gets all currently loaded L2PS network IDs.
     * @returns {string[]} Array of L2PS network IDs
     */
    getAllL2PSIds(): string[] {
        return Array.from(this.l2pses.keys())
    }

    /**
     * Loads all available L2PS networks from the data directory.
     * @returns {Promise<string[]>} Array of successfully loaded L2PS network IDs
     */
    async loadAllL2PS(): Promise<string[]> {
        const l2psJoinedUids: string[] = []
        const l2psDir = path.join(process.cwd(), "data", "l2ps")
        if (!fs.existsSync(l2psDir)) {
            log.warning("[L2PS] Data directory not found, creating...")
            fs.mkdirSync(l2psDir, { recursive: true })
            return []
        }

        const dirs = fs
            .readdirSync(l2psDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)

        for (const uid of dirs) {
            // Skip directories that don't carry a config.json. The
            // bundled `data/l2ps/example/` ships only a stale
            // `private.key` placeholder; without this guard the loader
            // throws on every boot. Operators who actually want to
            // join an L2PS network drop a real config.json under
            // `data/l2ps/<uid>/` — see testing/devnet/l2ps/<uid> for
            // the canonical layout. Epic 12 follow-up.
            const cfgPath = path.join(l2psDir, uid, "config.json")
            if (!fs.existsSync(cfgPath)) {
                log.info(
                    `[L2PS] Skipping ${uid}: no config.json (placeholder dir)`,
                )
                continue
            }
            try {
                await this.loadL2PS(uid)
                l2psJoinedUids.push(uid)
                log.info(`[L2PS] Loaded L2PS: ${uid}`)
            } catch (error) {
                const message = getErrorMessage(error)
                // `enabled: false` is an operator decision, not a fault.
                // Log as info so the noise floor stays low when sample
                // configs ship alongside live ones (e.g. data/l2ps/example).
                if (/invalid or disabled/i.test(message)) {
                    log.info(`[L2PS] Skipping ${uid}: ${message}`)
                } else {
                    log.error(`[L2PS] Failed to load L2PS ${uid}: ${message}`)
                }
            }
        }
        getSharedState.l2psJoinedUids = l2psJoinedUids
        return l2psJoinedUids
    }

    /**
     * Encrypts a transaction for the specified L2PS network.
     * @param {string} uid - The L2PS network UID
     * @param {Transaction} tx - The original transaction to encrypt
     * @param {any} [senderIdentity] - Optional sender identity for the encrypted transaction wrapper
     * @returns {Promise<Transaction>} A new Transaction object containing the encrypted data
     */
    async encryptTransaction(
        uid: string,
        tx: Transaction,
        senderIdentity?: any,
    ): Promise<Transaction> {
        const l2ps = await this.loadL2PS(uid)
        const encryptedTx = await l2ps.encryptTx(tx, senderIdentity)

        // Sign encrypted transaction with node's private key
        const sharedState = getSharedState
        const signature = await TxValidatorPool.getInstance().sign(
            sharedState.signingAlgorithm,
            new TextEncoder().encode(JSON.stringify(encryptedTx.content)),
        )

        if (signature) {
            encryptedTx.signature = {
                type: sharedState.signingAlgorithm,
                data: uint8ArrayToHex(signature.signature),
            }
        }

        return encryptedTx
    }

    /**
     * Decrypts an L2PS encrypted transaction.
     * @param {string} uid - The L2PS network UID
     * @param {L2PSTransaction} encryptedTx - The encrypted Transaction object
     * @returns {Promise<Transaction>} The original decrypted Transaction
     */
    async decryptTransaction(
        uid: string,
        encryptedTx: L2PSTransaction,
    ): Promise<Transaction> {
        const l2ps = await this.loadL2PS(uid)

        // Verify signature before decrypting
        if (encryptedTx.signature) {
            const isValid = await TxValidatorPool.getInstance().verify({
                algorithm: encryptedTx.signature.type as SigningAlgorithm,
                message: new TextEncoder().encode(JSON.stringify(encryptedTx.content)),
                publicKey: hexToUint8Array(encryptedTx.content.from as string),
                signature: hexToUint8Array(encryptedTx.signature.data),
            })

            if (!isValid) {
                throw new Error(`L2PS transaction signature verification failed for ${uid}`)
            }
        } else {
            log.warning(`[L2PS] No signature found on encrypted transaction for ${uid}`)
        }

        return l2ps.decryptTx(encryptedTx)
    }

    /**
     * Checks if a transaction is an L2PS encrypted transaction.
     * @param {L2PSTransaction} tx - The transaction to check
     * @returns {boolean} True if the transaction is of type l2psEncryptedTx
     */
    isL2PSTransaction(tx: L2PSTransaction): boolean {
        return tx.content.type === "l2psEncryptedTx"
    }

    /**
     * Extracts the L2PS UID from an encrypted transaction.
     * @param {L2PSTransaction} tx - The encrypted transaction
     * @returns {string | undefined} The L2PS UID if valid, undefined otherwise
     */
    getL2PSUidFromTransaction(tx: L2PSTransaction): string | undefined {
        if (!this.isL2PSTransaction(tx)) {
            return undefined
        }

        try {
            // Validate array before destructuring
            if (!Array.isArray(tx.content.data) || tx.content.data.length < 2) {
                log.error("[L2PS] Invalid transaction data format: expected array with at least 2 elements")
                return undefined
            }

            const [dataType, payload] = tx.content.data
            if (dataType === "l2psEncryptedTx") {
                const encryptedPayload = payload as L2PSEncryptedPayload
                return encryptedPayload.l2ps_uid
            }
        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS] Error extracting L2PS UID from transaction: ${message}`)
        }

        return undefined
    }

    /**
     * Processes an L2PS transaction in the mempool.
     * @param {L2PSTransaction} tx - The L2PS encrypted transaction to process
     * @returns {Promise<{success: boolean, error?: string, l2ps_uid?: string, processed?: boolean}>} Processing result
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

            // L2PS transaction processing is handled by L2PSBatchAggregator
            log.debug(`[L2PS] Received L2PS transaction for network ${l2psUid}: ${tx.hash.slice(0, 20)}...`)

            return {
                success: true,
                l2ps_uid: l2psUid,
                processed: true,
            }
        } catch (error) {
            const message = getErrorMessage(error)
            return {
                success: false,
                error: `Failed to process L2PS transaction: ${message}`,
            }
        }
    }

    /**
     * Gets the configuration for a specific L2PS network.
     * @param {string} uid - The L2PS network UID
     * @returns {L2PSNodeConfig | undefined} The L2PS network configuration if found
     */
    getL2PSConfig(uid: string): L2PSNodeConfig | undefined {
        return this.configs.get(uid)
    }

    /**
     * Checks if an L2PS network is currently loaded.
     * @param {string} uid - The L2PS network UID
     * @returns {boolean} True if the L2PS network is loaded
     */
    isL2PSLoaded(uid: string): boolean {
        return this.l2pses.has(uid)
    }

    /**
     * Unloads an L2PS network and removes its configuration.
     * @param {string} uid - The L2PS network UID
     * @returns {boolean} True if the L2PS network was successfully unloaded
     */
    unloadL2PS(uid: string): boolean {
        this.configs.delete(uid)
        return this.l2pses.delete(uid)
    }
}
