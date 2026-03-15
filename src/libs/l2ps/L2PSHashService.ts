import L2PSMempool, { L2PS_STATUS } from "@/libs/blockchain/l2ps_mempool"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import SharedState, { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import getShard from "@/libs/consensus/v2/routines/getShard"
import getCommonValidatorSeed from "@/libs/consensus/v2/routines/getCommonValidatorSeed"
import { DTRManager } from "@/libs/network/dtr/dtrmanager"
import ensureGCRForUser from "@/libs/blockchain/gcr/gcr_routines/ensureGCRForUser"
import { getErrorMessage } from "@/utilities/errorMessage"
import { OmniOpcode } from "@/libs/omniprotocol/protocol/opcodes"
import { ConnectionPool } from "@/libs/omniprotocol/transport/ConnectionPool"
import { encodeJsonRequest } from "@/libs/omniprotocol/serialization/jsonEnvelope"
import { getNodePrivateKey, getNodePublicKey } from "@/libs/omniprotocol/integration/keys"
import type { L2PSHashUpdateRequest } from "@/libs/omniprotocol/serialization/l2ps"
import { confirmTransaction } from "@/libs/blockchain/routines/validateTransaction"
import { Config } from "src/config"
import {
    HASH_RELAY_MAX_TOTAL_CONNECTIONS,
    HASH_RELAY_MAX_CONNECTIONS_PER_PEER,
    HASH_RELAY_IDLE_TIMEOUT_MS,
    HASH_RELAY_CONNECT_TIMEOUT_MS,
    HASH_RELAY_AUTH_TIMEOUT_MS,
    HASH_RELAY_OMNI_REQUEST_TIMEOUT_MS,
} from "./constants"

/**
 * L2PS Hash Generation Service
 * 
 * Generates consolidated hashes for L2PS networks every 5 seconds and relays them
 * to validators via DTR (Distributed Transaction Routing). This service enables
 * validators to track L2PS network activity without accessing transaction content,
 * preserving privacy while maintaining consensus participation.
 * 
 * Key Features:
 * - Reentrancy protection prevents overlapping hash generation cycles
 * - Automatic retry with sequential fallback across validators for failed relays
 * - Comprehensive error handling and logging
 * - Graceful shutdown support
 * - Performance monitoring and statistics
 */
export class L2PSHashService {
    private static instance: L2PSHashService | null = null

    /** Interval timer for hash generation cycles */
    private intervalId: NodeJS.Timeout | null = null

    /** Private constructor enforces singleton pattern */
    private constructor() { }

    /** Reentrancy protection flag - prevents overlapping operations */
    private isGenerating = false

    /** Service running state */
    private isRunning = false

    /** Hash generation interval in milliseconds */
    private readonly GENERATION_INTERVAL = Config.getInstance().l2ps.hashIntervalMs

    /** Statistics tracking */
    private stats = {
        totalCycles: 0,
        successfulCycles: 0,
        failedCycles: 0,
        skippedCycles: 0,
        totalHashesGenerated: 0,
        successfulRelays: 0,
        lastCycleTime: 0,
        averageCycleTime: 0,
    }

    /** Shared Demos SDK instance for creating transactions */
    private demos: Demos | null = null

    /** OmniProtocol connection pool for efficient TCP communication */
    private connectionPool: ConnectionPool | null = null

    /** OmniProtocol enabled flag */
    private readonly omniEnabled: boolean = Config.getInstance().omni.enabled

    /**
     * Get singleton instance of L2PS Hash Service
     * @returns L2PSHashService instance
     */
    static getInstance(): L2PSHashService {
        if (!this.instance) {
            this.instance = new L2PSHashService()
        }
        return this.instance
    }

    /**
     * Start the L2PS hash generation service
     * 
     * Begins generating consolidated hashes every 5 seconds for all joined L2PS networks.
     * Uses reentrancy protection to prevent overlapping operations.
     * 
     * @throws {Error} If service is already running
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("[L2PS Hash Service] Service is already running")
        }

        log.info("[L2PS Hash Service] Starting hash generation service")

        this.isRunning = true
        this.isGenerating = false

        // Reset statistics
        this.stats = {
            totalCycles: 0,
            successfulCycles: 0,
            failedCycles: 0,
            skippedCycles: 0,
            totalHashesGenerated: 0,
            successfulRelays: 0,
            lastCycleTime: 0,
            averageCycleTime: 0,
        }

        // Initialize Demos instance once for reuse
        this.demos = new Demos()

        // Initialize OmniProtocol connection pool if enabled
        if (this.omniEnabled) {
            this.connectionPool = new ConnectionPool({
                maxTotalConnections: HASH_RELAY_MAX_TOTAL_CONNECTIONS,
                maxConnectionsPerPeer: HASH_RELAY_MAX_CONNECTIONS_PER_PEER,
                idleTimeout: HASH_RELAY_IDLE_TIMEOUT_MS,
                connectTimeout: HASH_RELAY_CONNECT_TIMEOUT_MS,
                authTimeout: HASH_RELAY_AUTH_TIMEOUT_MS,
            })
            log.info("[L2PS Hash Service] OmniProtocol enabled for hash relay")
        }

        // Start the interval timer
        this.intervalId = setInterval(async () => {
            await this.safeGenerateAndRelayHashes()
        }, this.GENERATION_INTERVAL)

        log.info(`[L2PS Hash Service] Started with ${this.GENERATION_INTERVAL}ms interval`)
    }

    /**
     * Stop the L2PS hash generation service
     * 
     * Gracefully shuts down the service, waiting for any ongoing operations to complete.
     * 
     * @param timeoutMs - Maximum time to wait for ongoing operations (default: 10 seconds)
     */
    async stop(timeoutMs = 10000): Promise<void> {
        if (!this.isRunning) {
            return
        }

        log.info("[L2PS Hash Service] Stopping hash generation service")

        this.isRunning = false

        // Clear the interval
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }

        // Wait for ongoing operation to complete
        const startTime = Date.now()
        while (this.isGenerating && (Date.now() - startTime) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }

        if (this.isGenerating) {
            log.warning("[L2PS Hash Service] Forced shutdown - operation still in progress")
        }

        log.info("[L2PS Hash Service] Stopped successfully")
        this.logStatistics()
    }

    /**
     * Safe wrapper for hash generation with reentrancy protection
     * 
     * Prevents overlapping hash generation cycles that could cause database conflicts
     * and performance issues. Skips cycles if previous operation is still running.
     */
    private async safeGenerateAndRelayHashes(): Promise<void> {
        // Reentrancy protection - skip if already generating
        if (this.isGenerating) {
            this.stats.skippedCycles++
            log.warning("[L2PS Hash Service] Skipping cycle - previous operation still in progress")
            return
        }

        // Service shutdown check
        if (!this.isRunning) {
            return
        }

        this.stats.totalCycles++
        const cycleStartTime = Date.now()

        try {
            this.isGenerating = true
            await this.generateAndRelayHashes()

            this.stats.successfulCycles++
            this.updateCycleTime(Date.now() - cycleStartTime)

        } catch (error: unknown) {
            this.stats.failedCycles++
            const message = getErrorMessage(error)
            log.error(`[L2PS Hash Service] Hash generation cycle failed: ${message}`)

        } finally {
            this.isGenerating = false
        }
    }

    /**
     * Generate consolidated hashes for all joined L2PS networks and relay to validators
     * 
     * Core hash generation logic that:
     * 1. Iterates through all joined L2PS UIDs
     * 2. Generates consolidated hashes using L2PSMempool
     * 3. Creates L2PS hash update transactions
     * 4. Relays to validators via DTR infrastructure
     */
    private async generateAndRelayHashes(): Promise<void> {
        try {
            // Get all joined L2PS UIDs from shared state
            const joinedUIDs = SharedState.getInstance().l2psJoinedUids || []

            if (joinedUIDs.length === 0) {
                return // No L2PS networks to process
            }

            log.debug(`[L2PS Hash Service] Processing ${joinedUIDs.length} L2PS networks`)

            // Process each L2PS network
            for (const l2psUid of joinedUIDs) {
                await this.processL2PSNetwork(l2psUid)
            }

        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Hash Service] Error in hash generation: ${message}`)
            throw error
        }
    }

    /**
     * Process a single L2PS network for hash generation and relay
     * 
     * @param l2psUid - L2PS network identifier
     */
    private async processL2PSNetwork(l2psUid: string): Promise<void> {
        try {
            // Generate consolidated hash for this L2PS UID
            const consolidatedHash = await L2PSMempool.getHashForL2PS(l2psUid)

            // Validate hash generation succeeded
            if (!consolidatedHash || consolidatedHash.length === 0) {
                log.warning(`[L2PS Hash Service] Invalid hash generated for L2PS ${l2psUid}, skipping`)
                return
            }

            // Get transaction count for this UID (only executed transactions awaiting batching)
            const transactions = await L2PSMempool.getByUID(l2psUid, L2PS_STATUS.EXECUTED)
            const transactionCount = transactions.length

            // Only generate hash update if there are transactions
            if (transactionCount === 0) {
                log.debug(`[L2PS Hash Service] No transactions for L2PS ${l2psUid}, skipping`)
                return
            }

            // Create L2PS hash update transaction using SDK
            if (!this.demos) {
                throw new Error("[L2PS Hash Service] Demos instance not initialized - service not started properly")
            }
            const hashUpdateTx = await DemosTransactions.createL2PSHashUpdate(
                l2psUid,
                consolidatedHash,
                transactionCount,
                this.demos,
            )
            const normalizedHashUpdateTx =
                await this.normalizeHashUpdateTransaction(hashUpdateTx)
            const validityData = await confirmTransaction(
                normalizedHashUpdateTx as any,
                normalizedHashUpdateTx.content.from,
            )

            this.stats.totalHashesGenerated++

            // Relay to validators via DTR infrastructure
            // Note: Self-directed transaction will automatically trigger DTR routing
            await this.relayToValidators(normalizedHashUpdateTx, validityData)

            this.stats.successfulRelays++

            log.debug(`[L2PS Hash Service] Generated hash for ${l2psUid}: ${consolidatedHash} (${transactionCount} txs)`)

        } catch (error: unknown) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Hash Service] Error processing L2PS ${l2psUid}: ${message}`)
            // Continue processing other L2PS networks even if one fails
        }
    }

    /**
     * Normalize SDK-produced hash update transactions before relay.
     *
     * The published demosdk can return a malformed nonce payload from
     * `getAddressNonce()` in some environments, which produces values like
     * `"[object Object]1"`. Re-read the authoritative nonce from RPC and re-sign
     * locally so relay payloads stay coherent even when the bundled SDK is stale.
     */
    private async normalizeHashUpdateTransaction(hashUpdateTx: any): Promise<any> {
        const nonce = hashUpdateTx?.content?.nonce

        if (
            (typeof nonce === "number" && Number.isFinite(nonce)) ||
            (typeof nonce === "string" && /^\d+$/.test(nonce))
        ) {
            return hashUpdateTx
        }

        const address = hashUpdateTx?.content?.from
        if (!address) {
            throw new Error("[L2PS Hash Service] Hash update transaction missing sender address")
        }

        const account = await ensureGCRForUser(address)
        const rawNonce = account?.details?.content?.nonce
        const currentNonce =
            typeof rawNonce === "number"
                ? rawNonce
                : Number.parseInt(String(rawNonce ?? "0"), 10)

        if (!Number.isFinite(currentNonce)) {
            throw new Error(
                `[L2PS Hash Service] Failed to recover nonce for ${address}: ${String(rawNonce)}`,
            )
        }

        const normalizedTx = structuredClone(hashUpdateTx)
        normalizedTx.content.nonce = currentNonce + 1

        log.debug(
            `[L2PS Hash Service] Normalized malformed hash-update nonce for ${address} -> ${normalizedTx.content.nonce}`,
        )

        return await this.demos.sign(normalizedTx)
    }

    /**
     * Relay hash update transaction to validators via DTR or OmniProtocol
     *
     * Uses OmniProtocol when enabled for efficient binary communication,
     * falls back to HTTP DTR infrastructure if OmniProtocol is disabled
     * or fails.
     *
     * @param hashUpdateTx - Signed L2PS hash update transaction
     */
    private async relayToValidators(
        hashUpdateTx: any,
        validityData: ValidityData,
    ): Promise<void> {
        try {
            // Allow explicit local-devnet relay coverage without switching the full node into PROD.
            const allowNonProdRelay = process.env.L2PS_HASH_RELAY_NON_PROD === "true"
            if (!getSharedState.PROD && !allowNonProdRelay) {
                log.debug("[L2PS Hash Service] Skipping DTR relay (non-production mode)")
                return
            }

            // Get validators using same logic as DTR RelayRetryService
            const { commonValidatorSeed } = await getCommonValidatorSeed()
            const localIdentity = getSharedState.publicKeyHex
            const validators = await getShard(commonValidatorSeed)
            const availableValidators = validators
                .filter(v => v.identity !== localIdentity)
                .filter(v => v.status.online && v.sync.status)
                .sort(() => Math.random() - 0.5) // Random order for load balancing

            if (availableValidators.length === 0) {
                throw new Error("No validators available for L2PS hash relay")
            }

            log.debug(`[L2PS Hash Service] Attempting to relay hash update to ${availableValidators.length} validators`)

            // Try all validators in random order (same pattern as DTR)
            for (const validator of availableValidators) {
                try {
                    // Try OmniProtocol first if enabled
                    if (this.omniEnabled && this.connectionPool) {
                        const omniSuccess = await this.relayViaOmniProtocol(validator, hashUpdateTx)
                        if (omniSuccess) {
                            log.info(`[L2PS Hash Service] Successfully relayed via OmniProtocol to validator ${validator.identity.substring(0, 8)}...`)
                            return
                        }
                        // Fall through to HTTP if OmniProtocol fails
                        log.debug(`[L2PS Hash Service] OmniProtocol failed for ${validator.identity.substring(0, 8)}..., trying HTTP`)
                    }

                    // HTTP fallback
                    const result = await DTRManager.relayTransactions(
                        validator,
                        [validityData],
                    )

                    if (result.result === 200) {
                        log.info(`[L2PS Hash Service] Successfully relayed hash update via HTTP to validator ${validator.identity.substring(0, 8)}...`)
                        return // Success - one validator accepted is enough
                    }

                    log.debug(`[L2PS Hash Service] Validator ${validator.identity.substring(0, 8)}... rejected hash update: ${result.response}`)

                } catch (error) {
                    const message = getErrorMessage(error)
                    log.debug(`[L2PS Hash Service] Validator ${validator.identity.substring(0, 8)}... error: ${message}`)
                    continue // Try next validator
                }
            }

            // If we reach here, all validators failed
            throw new Error(`All ${availableValidators.length} validators failed to accept L2PS hash update`)

        } catch (error) {
            const message = getErrorMessage(error)
            log.error(`[L2PS Hash Service] Failed to relay hash update to validators: ${message}`)
            throw error
        }
    }

    /**
     * Relay hash update via OmniProtocol
     *
     * Uses the L2PS_HASH_UPDATE opcode (0x77) for efficient binary communication.
     *
     * @param validator - Validator peer to relay to
     * @param hashUpdateTx - Hash update transaction data
     * @returns true if relay succeeded, false if failed
     */
    private async relayViaOmniProtocol(validator: any, hashUpdateTx: any): Promise<boolean> {
        if (!this.connectionPool) {
            return false
        }

        try {
            // Get node keys for authentication
            const privateKey = getNodePrivateKey()
            const publicKey = getNodePublicKey()

            if (!privateKey || !publicKey) {
                log.warning("[L2PS Hash Service] Node keys not available for OmniProtocol")
                return false
            }

            // Convert HTTP URL to TCP connection string
            const httpUrl = validator.connection?.string || validator.url
            if (!httpUrl) {
                return false
            }

            const url = new URL(httpUrl)
            const tcpProtocol = Config.getInstance().omni.tls.enabled ? "tls" : "tcp"
            const peerHttpPort = Number.parseInt(url.port, 10) || 80
            const omniPort = peerHttpPort + 1
            const tcpConnectionString = `${tcpProtocol}://${url.hostname}:${omniPort}`

            // Prepare L2PS hash update request payload
            const hashPayload =
                hashUpdateTx?.content?.data?.[0] === "l2ps_hash_update"
                    ? hashUpdateTx.content.data[1]
                    : undefined
            const l2psUid = hashPayload?.l2ps_uid || hashUpdateTx.l2ps_uid
            const consolidatedHash =
                hashPayload?.consolidated_hash || hashUpdateTx.hash
            const transactionCount =
                hashPayload?.transaction_count || hashUpdateTx.transaction_count || 0

            const hashUpdateRequest: L2PSHashUpdateRequest = {
                l2psUid,
                consolidatedHash,
                transactionCount,
                blockNumber: 0, // Will be filled by validators
                timestamp: Date.now(),
            }

            // Encode request as JSON (handlers use JSON envelope)
            const payload = encodeJsonRequest(hashUpdateRequest)

            // Send authenticated request via OmniProtocol
            const responseBuffer = await this.connectionPool.sendAuthenticated(
                validator.identity,
                tcpConnectionString,
                OmniOpcode.L2PS_HASH_UPDATE,
                payload,
                privateKey,
                publicKey,
                { timeout: HASH_RELAY_OMNI_REQUEST_TIMEOUT_MS },
            )

            // Check response status (first 2 bytes)
            if (responseBuffer.length >= 2) {
                const status = responseBuffer.readUInt16BE(0)
                return status === 200
            }

            return false

        } catch (error) {
            const message = getErrorMessage(error)
            log.debug(`[L2PS Hash Service] OmniProtocol relay error: ${message}`)
            return false
        }
    }

    /**
     * Update average cycle time statistics
     * 
     * @param cycleTime - Time taken for this cycle in milliseconds
     */
    private updateCycleTime(cycleTime: number): void {
        this.stats.lastCycleTime = cycleTime

        // Calculate running average
        const totalTime = (this.stats.averageCycleTime * (this.stats.successfulCycles - 1)) + cycleTime
        this.stats.averageCycleTime = Math.round(totalTime / this.stats.successfulCycles)
    }

    /**
     * Log comprehensive service statistics
     */
    private logStatistics(): void {
        log.info("[L2PS Hash Service] Final Statistics:" + "\n" + JSON.stringify({
            totalCycles: this.stats.totalCycles,
            successfulCycles: this.stats.successfulCycles,
            failedCycles: this.stats.failedCycles,
            skippedCycles: this.stats.skippedCycles,
            successRate: this.stats.totalCycles > 0
                ? `${Math.round((this.stats.successfulCycles / this.stats.totalCycles) * 100)}%`
                : "0%",
            totalHashesGenerated: this.stats.totalHashesGenerated,
            successfulRelays: this.stats.successfulRelays,
            averageCycleTime: `${this.stats.averageCycleTime}ms`,
            lastCycleTime: `${this.stats.lastCycleTime}ms`,
        }))
    }

    /**
     * Get current service statistics
     * 
     * @returns Current service statistics object
     */
    getStatistics(): typeof this.stats {
        return { ...this.stats }
    }

    /**
     * Get current service status
     * 
     * @returns Service status information
     */
    getStatus(): {
        isRunning: boolean;
        isGenerating: boolean;
        intervalMs: number;
        joinedL2PSCount: number;
    } {
        return {
            isRunning: this.isRunning,
            isGenerating: this.isGenerating,
            intervalMs: this.GENERATION_INTERVAL,
            joinedL2PSCount: SharedState.getInstance().l2psJoinedUids?.length || 0,
        }
    }

    /**
     * Force a single hash generation cycle (for testing/debugging)
     * 
     * @throws {Error} If service is not running or already generating
     */
    async forceGeneration(): Promise<void> {
        if (!this.isRunning) {
            throw new Error("[L2PS Hash Service] Service is not running")
        }

        if (this.isGenerating) {
            throw new Error("[L2PS Hash Service] Generation already in progress")
        }

        log.info("[L2PS Hash Service] Forcing hash generation cycle")
        await this.safeGenerateAndRelayHashes()
    }
}
