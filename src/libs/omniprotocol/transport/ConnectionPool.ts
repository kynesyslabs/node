// REVIEW: ConnectionPool - Manages pool of bidirectional TCP connections (both inbound and outbound)
import { Socket } from "net"
import { EventEmitter } from "events"
import { PeerConnection } from "./PeerConnection"
import {
    ConnectionState,
    ConnectionStateUtils,
    type ConnectionOptions,
    type PoolConfig,
    type PoolStats,
    type ConnectionInfo,
    type ConnectionOrigin,
} from "./types"
import { PoolCapacityError, RequestTimeoutError } from "../types/errors"
import log from "@/utilities/logger"
import { RateLimiter } from "../ratelimit"
import { PeerManager } from "@/libs/peer"
import { DEFAULT_OMNIPROTOCOL_CONFIG } from "../types/config"
import {
    DEFAULT_POOL_MAX_TOTAL_CONNECTIONS,
    DEFAULT_POOL_MAX_CONNECTIONS_PER_PEER,
    DEFAULT_POOL_IDLE_TIMEOUT_MS,
    DEFAULT_POOL_CONNECT_TIMEOUT_MS,
    DEFAULT_POOL_AUTH_TIMEOUT_MS,
    POOL_CLEANUP_INTERVAL_MS,
} from "../constants"

/**
 * ConnectionPool manages bidirectional TCP connections to multiple peer nodes
 *
 * Unified connection management for both:
 * - OUTBOUND connections: We initiate TCP connect to remote peer via acquire()
 * - INBOUND connections: Remote peer connects to us via handleInboundSocket()
 *
 * Features:
 * - Per-peer connection pooling (default: max connections per peer configurable)
 * - Global connection limit enforcement
 * - Lazy connection creation for outbound (create on first use)
 * - Automatic inbound registration after authentication
 * - Automatic idle connection cleanup
 * - Connection reuse for efficiency (prefers newest connection)
 * - Health monitoring and statistics
 *
 * Connection lifecycle:
 * OUTBOUND:
 *   1. acquire() → get or create connection
 *   2. send() → use connection for request-response
 *   3. Automatic idle cleanup after timeout
 *
 * INBOUND:
 *   1. handleInboundSocket() → create PeerConnection with pending identity
 *   2. On "authenticated" event → re-register under real peer identity
 *   3. Connection now usable for bidirectional messaging
 *   4. Automatic idle cleanup after timeout
 */
/**
 * The options for the send that follows a connect, with what is left of the
 * request's timeout. Nothing left means the request is not sent at all.
 */
function remainingOptions(
    options: ConnectionOptions,
    deadline: number | undefined,
): ConnectionOptions {
    if (deadline === undefined) {
        return options
    }
    const timeout = deadline - Date.now()
    if (timeout <= 0) {
        throw new RequestTimeoutError(
            `Request timeout: connecting took the whole ${options.timeout}ms`,
        )
    }
    return { ...options, timeout }
}

export class ConnectionPool extends EventEmitter {
    private static instance: ConnectionPool | null = null
    private readonly connections: Map<string, PeerConnection[]> = new Map()
    private readonly pendingConnections: Map<string, PeerConnection> = new Map() // Temp tracking before auth
    // Inbound connections that hold a per-IP slot in the rate limiter
    // (pending ones, and those authenticated as non-validators), with the IP
    // captured at accept time: remoteAddress is gone once the socket is
    // destroyed, and outbound connections never took a slot to give back.
    private readonly ipSlots: Map<PeerConnection, string> = new Map()
    // Callers between acquire() and release(), per connection. A caller
    // resumes after acquire() a turn later and only then puts its request in
    // flight, so an idle-looking socket may still be about to carry one.
    private readonly reservations: Map<PeerConnection, number> = new Map()
    // Outbound connects in progress, by peer identity and address.
    private readonly connecting: Map<string, Promise<PeerConnection>> = new Map()
    private readonly config: PoolConfig
    private cleanupTimer: NodeJS.Timeout | null = null
    public rateLimiter?: RateLimiter

    constructor(config: Partial<PoolConfig> = {}, rateLimiter?: RateLimiter) {
        super()
        this.config = {
            maxTotalConnections:
                config.maxTotalConnections ??
                DEFAULT_POOL_MAX_TOTAL_CONNECTIONS,
            maxConnectionsPerPeer:
                config.maxConnectionsPerPeer ??
                DEFAULT_POOL_MAX_CONNECTIONS_PER_PEER,
            idleTimeout: config.idleTimeout ?? DEFAULT_POOL_IDLE_TIMEOUT_MS,
            connectTimeout:
                config.connectTimeout ?? DEFAULT_POOL_CONNECT_TIMEOUT_MS,
            authTimeout: config.authTimeout ?? DEFAULT_POOL_AUTH_TIMEOUT_MS,
        }
        this.rateLimiter = rateLimiter

        // Start periodic cleanup of idle/dead connections
        this.startCleanupTimer()
    }

    /**
     * Handle an inbound socket connection from OmniProtocolServer
     *
     * Creates a PeerConnection in inbound mode with temporary identity.
     * Once authenticated, the connection is re-registered under the real peer identity.
     *
     * @param socket Incoming TCP socket
     * @returns Created PeerConnection (in PENDING_AUTH state)
     */
    handleInboundSocket(socket: Socket): PeerConnection {
        const remoteAddress = socket.remoteAddress || "unknown"
        const remotePort = socket.remotePort || 0

        log.debug(
            `==== DEBUG: Handling inbound socket from ${remoteAddress}:${remotePort} ====`,
        )
        log.debug(`Confirmed Connection count: ${this.connections.size}`)

        // Create temporary ID for tracking before authentication
        const tempId = `pending:${remoteAddress}:${remotePort}:${Date.now()}`

        // Create PeerConnection in inbound mode
        const connection = new PeerConnection(
            tempId,
            "", // No connection string for inbound
            socket,
            this.rateLimiter,
        )

        // Track in pending connections
        this.pendingConnections.set(tempId, connection)
        log.debug(`Pending connections: ${this.pendingConnections.size}`)

        if (this.rateLimiter) {
            this.rateLimiter.addConnection(remoteAddress)
            this.ipSlots.set(connection, remoteAddress)
        }

        // Listen for authentication to re-register under real identity
        connection.on("authenticated", (peerIdentity: string) => {
            this.registerAuthenticatedConnection(
                connection,
                peerIdentity,
                tempId,
            )
        })

        // Listen for connection close to cleanup
        connection.on("close", () => {
            this.handleConnectionClose(connection, tempId)
        })

        // Listen for errors
        connection.on("error", (error: Error) => {
            log.error(`[ConnectionPool] Connection ${tempId} error: ${error}`)
            this.emit("connection_error", tempId, error)
        })

        this.emit("connection_accepted", remoteAddress)
        return connection
    }

    /**
     * Re-register an inbound connection under its authenticated peer identity
     */
    private registerAuthenticatedConnection(
        connection: PeerConnection,
        peerIdentity: string,
        tempId: string,
    ): void {
        // Remove from pending tracking
        this.pendingConnections.delete(tempId)

        // A verified auth block proves only that the peer holds the key, and
        // keys are free, so an identity alone does not earn its way out of
        // the per-IP limit. Validators behind one NAT address share an IP:
        // they give the slot back once the chain says they are validators.
        void this.releaseIpSlotIfValidator(connection, peerIdentity)

        // Get existing connections for this peer
        const existing = this.connections.get(peerIdentity) || []

        // Check if we're at max connections for this peer
        const usableConnections = existing.filter(c =>
            ConnectionStateUtils.isUsable(c.getState()),
        )
        if (usableConnections.length >= this.config.maxConnectionsPerPeer) {
            // The new connection has just proved the key. Older inbound ones
            // under the same identity can belong to a process that no longer
            // speaks for it (a halted copy of the key, a restarted peer's
            // half-open socket); refusing the newest would lock the live
            // holder out of this node, so the least recently used one goes.
            const stalest = usableConnections
                .filter(c => c.origin === "inbound")
                .sort((a, b) => a.getLastActivity() - b.getLastActivity())[0]
            if (!stalest) {
                log.error(
                    `[ConnectionPool] Max connections per peer reached for ${peerIdentity}`,
                )
                log.error(
                    `[ConnectionPool] Rejecting connection ${connection.socketId} for ${peerIdentity}`,
                )
                connection.close().catch(() => {})
                this.emit("connection_rejected", peerIdentity, "max_connections")
                return
            }
            log.warning(
                `[ConnectionPool] Max connections per peer reached for ${peerIdentity}: ` +
                    `closing its least recently used inbound connection ${stalest.socketId} for ${connection.socketId}`,
            )
            existing.splice(existing.indexOf(stalest), 1)
            stalest.close().catch(() => {})
            this.emit("connection_evicted", peerIdentity, stalest.socketId)
        }

        // Add new connection
        existing.push(connection)
        this.connections.set(peerIdentity, existing)
        this.emit("peer_authenticated", peerIdentity, connection)
    }

    /**
     * Handle connection close event
     */
    private handleConnectionClose(
        connection: PeerConnection,
        tempId: string,
    ): void {
        const peerIdentity = connection.peerIdentity

        // Remove from pending if still there
        this.pendingConnections.delete(tempId)

        // Remove from main connections map
        const peerConnections = this.connections.get(peerIdentity)
        if (peerConnections) {
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }
            if (peerConnections.length === 0) {
                this.connections.delete(peerIdentity)
            }
        }

        this.releaseIpSlot(connection)

        this.emit("connection_closed", peerIdentity)
    }

    /**
     * Give back the connection's per-IP slot if its proven identity is in
     * the validator set. The lookup is async, so the connection may close
     * (and free the slot) first; releaseIpSlot makes the late call a no-op.
     */
    private async releaseIpSlotIfValidator(
        connection: PeerConnection,
        peerIdentity: string,
    ): Promise<void> {
        if (!this.ipSlots.has(connection)) return
        let validator = false
        try {
            const { isMergePeerEligible } = await import(
                "src/libs/consensus/mergePeerEligibility"
            )
            // Same rule as committee membership: the staked set and the
            // eligible pool from chain state, not the self-reported peerlist.
            validator = await isMergePeerEligible(peerIdentity)
        } catch (error) {
            log.warning(
                `[ConnectionPool] Validator lookup failed for ${peerIdentity}, keeping its per-IP slot: ${error}`,
            )
        }
        if (validator) {
            connection.markProvenValidator()
            this.releaseIpSlot(connection, true)
        }
    }

    /**
     * Give back the per-IP slot taken in handleInboundSocket. Safe to call
     * on every exit path: only the first call for a counted connection
     * decrements.
     */
    private releaseIpSlot(
        connection: PeerConnection,
        provenValidator = false,
    ): void {
        const ip = this.ipSlots.get(connection)
        if (ip === undefined) return
        this.ipSlots.delete(connection)
        if (provenValidator) {
            this.rateLimiter?.releaseValidatorConnection(ip)
        } else {
            this.rateLimiter?.removeConnection(ip)
        }
    }

    /**
     * Acquire a connection to a peer (create outbound if needed)
     *
     * Looks for existing usable connections first (prefers newest).
     * Creates new outbound connection if none available.
     *
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param options Connection options
     * @returns Promise resolving to ready PeerConnection
     */
    async acquire(
        peerIdentity: string,
        connectionString: string,
        options: ConnectionOptions = {},
    ): Promise<PeerConnection | null> {
        // Try to reuse existing usable connection (prefers newest)
        const totalConnections = this.getTotalConnectionCount()
        const existing = this.findUsableConnection(
            peerIdentity,
            connectionString,
        )

        if (existing) {
            this.reserve(existing)
            return existing
        }

        // A burst of first calls shares one connect: each extra socket would
        // be over the per-peer cap and closed again by the receiver.
        const connectKey = `${peerIdentity} ${connectionString}`
        const connecting = this.connecting.get(connectKey)
        if (connecting !== undefined) {
            const connection = await this.joinConnect(
                connecting,
                options.timeout,
            )
            this.reserve(connection)
            return connection
        }

        // Check pool capacity limits
        if (totalConnections >= this.config.maxTotalConnections) {
            throw new PoolCapacityError(
                `Pool at capacity: ${totalConnections}/${this.config.maxTotalConnections} connections`,
            )
        }

        // Check per-peer limits
        const peerConnections = this.connections.get(peerIdentity) || []
        const usable = peerConnections.filter(
            c =>
                c.origin === "outbound" &&
                ConnectionStateUtils.isUsable(c.getState()),
        )
        let retiring: Promise<void> | null = null
        if (usable.length >= this.config.maxConnectionsPerPeer) {
            // None of these reach connectionString, so after an address
            // change they only serve the requests already on them. An idle
            // one gives its slot to the new address.
            const retired = this.findOldestConnection(
                usable.filter(
                    c =>
                        c.connectionString !== connectionString &&
                        c.getInfo().inFlightCount === 0 &&
                        !this.reservations.has(c),
                ),
            )
            if (!retired) {
                throw new PoolCapacityError(
                    `Max connections to peer ${peerIdentity}: ${usable.length}/${this.config.maxConnectionsPerPeer}`,
                )
            }
            log.debug(
                `[ConnectionPool] Retiring idle connection to ${retired.connectionString} for ${peerIdentity} at ${connectionString}`,
            )
            // Not awaited here: closeConnection drops it from the pool
            // synchronously, and nothing may run between this check and
            // registering the new connection, or a concurrent acquire could
            // register one this call then overwrites.
            retiring = this.closeConnection(retired)
        }

        // Create new outbound connection
        const connection = new PeerConnection(peerIdentity, connectionString)

        // Add to pool before connecting (allows tracking). Re-read: retiring
        // may have removed this peer's entry.
        const tracked = this.connections.get(peerIdentity) || []
        tracked.push(connection)
        this.connections.set(peerIdentity, tracked)

        // Listen for close
        connection.on("close", () => {
            this.handleConnectionClose(connection, "")
        })

        const removeConnectionFromPool = (connection: PeerConnection): void => {
            const peerConnections = this.connections.get(peerIdentity) || []

            if (peerConnections.length === 0) {
                this.connections.delete(peerIdentity)
                return
            }

            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
                this.connections.set(peerIdentity, peerConnections)
            }
        }

        connection.on("error", (error: Error) => {
            log.error("Connection error in connection handler")
            // throw error
            removeConnectionFromPool(connection)
            return null
        })

        const connected = (async () => {
            try {
                await retiring

                // The request timeout bounds the answer, not the TCP
                // connect: a closed or filtered Omni port must fail within
                // connectTimeout. A connect longer than the call itself
                // would only stall the call past its own deadline.
                await connection.connect({
                    timeout: Math.min(
                        this.config.connectTimeout,
                        options.timeout ?? Infinity,
                    ),
                    retries: options.retries,
                })

                log.debug(
                    `[ConnectionPool] Created outbound connection to ${peerIdentity}`,
                )
                return connection
            } catch (error) {
                // Remove failed connection from pool
                removeConnectionFromPool(connection)
                throw error
            } finally {
                this.connecting.delete(connectKey)
            }
        })()
        this.connecting.set(connectKey, connected)

        await connected
        this.reserve(connection)
        return connection
    }

    /**
     * Wait for a connect another call started, within this call's own
     * timeout: the connect runs on the starter's, possibly longer, budget.
     * Giving up here leaves the connect running for the other callers.
     */
    private async joinConnect(
        connecting: Promise<PeerConnection>,
        timeout: number | undefined,
    ): Promise<PeerConnection> {
        if (timeout === undefined) {
            return connecting
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new RequestTimeoutError(
                            `No connection within ${timeout}ms`,
                        ),
                    ),
                timeout,
            )
        })
        try {
            return await Promise.race([connecting, expired])
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * A request that timed out says the peer is slow, not that the socket is
     * broken: its entry is already dropped and a late answer is ignored by
     * sequence. Closing would fail every other request on the connection.
     */
    private async closeUnlessSlow(
        connection: PeerConnection,
        error: unknown,
    ): Promise<void> {
        if (error instanceof RequestTimeoutError) {
            return
        }
        await this.closeConnection(connection)
    }

    private reserve(connection: PeerConnection): void {
        this.reservations.set(
            connection,
            (this.reservations.get(connection) ?? 0) + 1,
        )
    }

    /**
     * Release a connection back to the pool
     * Does not close the connection. Every acquire() must be paired with one
     * release(): until then the connection is never retired for another
     * address.
     */
    release(connection: PeerConnection): void {
        const count = this.reservations.get(connection)
        if (count === undefined) return
        if (count <= 1) {
            this.reservations.delete(connection)
        } else {
            this.reservations.set(connection, count - 1)
        }
    }

    /**
     * Send a request to a peer (acquire connection, send, release)
     * Convenience method that handles connection lifecycle
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param opcode OmniProtocol opcode
     * @param payload Request payload
     * @param options Request options
     * @returns Promise resolving to response payload
     */
    async send(
        peerIdentity: string,
        connectionString: string,
        opcode: number,
        payload: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        return this.request(
            peerIdentity,
            connectionString,
            options,
            (connection, remaining) =>
                connection.send(opcode, payload, remaining),
        )
    }

    /**
     * Send an authenticated request to a peer
     * Convenience method that handles connection lifecycle with authentication
     * @param peerIdentity Peer public key or identifier
     * @param connectionString Connection string (e.g., "tcp://ip:port")
     * @param opcode OmniProtocol opcode
     * @param payload Request payload
     * @param privateKey Ed25519 private key for signing
     * @param publicKey Ed25519 public key for identity
     * @param options Request options
     * @returns Promise resolving to response payload
     */
    async sendAuthenticated(
        peerIdentity: string,
        connectionString: string,
        opcode: number,
        payload: Buffer,
        privateKey: Buffer,
        publicKey: Buffer,
        options: ConnectionOptions = {},
    ): Promise<Buffer> {
        return this.request(
            peerIdentity,
            connectionString,
            options,
            (connection, remaining) =>
                connection.sendAuthenticated(
                    opcode,
                    payload,
                    privateKey,
                    publicKey,
                    remaining,
                ),
        )
    }

    /**
     * One request on a pooled connection. options.timeout bounds the whole
     * request, connect included: the answer gets only what the connect,
     * our own or one we joined, left of it.
     */
    private async request(
        peerIdentity: string,
        connectionString: string,
        options: ConnectionOptions,
        sendOn: (
            connection: PeerConnection,
            remaining: ConnectionOptions,
        ) => Promise<Buffer>,
    ): Promise<Buffer> {
        const deadline =
            options.timeout === undefined
                ? undefined
                : Date.now() + options.timeout
        let connection: PeerConnection | null = null

        try {
            connection = await this.acquire(
                peerIdentity,
                connectionString,
                options,
            )

            if (!connection) {
                throw new Error("Connection not found")
            }

            const response = await sendOn(
                connection,
                remainingOptions(options, deadline),
            )
            this.release(connection)
            return response
        } catch (error) {
            log.error(
                `[ConnectionPool] Error sending request to ${peerIdentity}: ${error}`,
            )
            if (connection) {
                this.release(connection)
                await this.closeUnlessSlow(connection, error)
            }

            throw error
        }
    }

    /**
     * Get pool statistics for monitoring
     */
    getStats(): PoolStats & {
        pendingAuth: number
        inbound: number
        outbound: number
    } {
        let totalConnections = 0
        let activeConnections = 0
        let idleConnections = 0
        let connectingConnections = 0
        let deadConnections = 0
        let inbound = 0
        let outbound = 0

        for (const peerConnections of this.connections.values()) {
            for (const connection of peerConnections) {
                totalConnections++

                const state = connection.getState()
                // Use numeric comparisons for state categorization
                if (state === ConnectionState.READY) {
                    activeConnections++
                } else if (ConnectionStateUtils.isUsable(state)) {
                    // AUTHENTICATED or IDLE (both value 10)
                    idleConnections++
                } else if (
                    state > ConnectionState.UNINITIALIZED &&
                    state < ConnectionState.AUTHENTICATED
                ) {
                    // CONNECTING, CONNECTED, PENDING_AUTH (1-9)
                    connectingConnections++
                } else if (ConnectionStateUtils.isTerminal(state)) {
                    deadConnections++
                }

                if (connection.origin === "inbound") {
                    inbound++
                } else {
                    outbound++
                }
            }
        }

        return {
            totalConnections: totalConnections + this.pendingConnections.size,
            activeConnections,
            idleConnections,
            connectingConnections,
            deadConnections,
            pendingAuth: this.pendingConnections.size,
            inbound,
            outbound,
        }
    }

    /**
     * Get connection information for a specific peer
     */
    getConnectionInfo(
        peerIdentity: string,
    ): (ConnectionInfo & { origin: ConnectionOrigin })[] {
        const peerConnections = this.connections.get(peerIdentity) || []
        return peerConnections.map(conn => conn.getInfo())
    }

    /**
     * Get connection information for all peers
     */
    getAllConnectionInfo(): Map<
        string,
        (ConnectionInfo & { origin: ConnectionOrigin })[]
    > {
        const result = new Map<
            string,
            (ConnectionInfo & { origin: ConnectionOrigin })[]
        >()

        for (const [peerIdentity, connections] of this.connections.entries()) {
            result.set(
                peerIdentity,
                connections.map(conn => conn.getInfo()),
            )
        }

        return result
    }

    /**
     * Get connection count
     */
    getConnectionCount(): number {
        return this.getTotalConnectionCount() + this.pendingConnections.size
    }

    /**
     * Get all connections for a specific peer
     * Used for cross-connection response routing
     */
    getConnections(peerIdentity: string): PeerConnection[] {
        return this.connections.get(peerIdentity) ?? []
    }

    /**
     * Get connection count by IP address
     */
    getConnectionCountByIp(ipAddress: string): number {
        log.debug(`Counting connections for IP: ${ipAddress}`)
        let count = 0

        for (const peerConnections of this.connections.values()) {
            for (const conn of peerConnections) {
                log.debug(`Found IP: ${conn.socket?.remoteAddress}`)
                if (
                    conn.socket?.remoteAddress === ipAddress &&
                    !conn.socket.destroyed
                ) {
                    count++
                }
            }
        }

        for (const conn of this.pendingConnections.values()) {
            if (conn.socket?.remoteAddress === ipAddress) {
                log.debug(`Found pending IP: ${conn.socket?.remoteAddress}`)
                count++
            }
        }

        return count
    }

    /**
     * Gracefully shutdown the pool
     */
    async shutdown(): Promise<void> {
        // Stop cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }

        // Close all connections in parallel
        const closePromises: Promise<void>[] = []

        for (const peerConnections of this.connections.values()) {
            for (const connection of peerConnections) {
                closePromises.push(connection.close())
            }
        }

        for (const connection of this.pendingConnections.values()) {
            closePromises.push(connection.close())
        }

        await Promise.allSettled(closePromises)

        // Clear all connections
        this.connections.clear()
        this.pendingConnections.clear()

        log.info("[ConnectionPool] Shutdown complete")
    }

    /**
     * Find an existing usable connection for a peer (prefers newest)
     */
    /**
     * Only a socket opened to `connectionString` may carry the call: a hello
     * to an address proves who serves it only if it actually reaches it.
     */
    private findUsableConnection(
        peerIdentity: string,
        connectionString: string,
    ): PeerConnection | null {
        const peerConnections = this.connections.get(peerIdentity)
        if (!peerConnections || peerConnections.length === 0) {
            return null
        }

        const usable = peerConnections.filter(
            conn =>
                conn.origin === "outbound" &&
                conn.connectionString === connectionString &&
                ConnectionStateUtils.isUsable(conn.getState()),
        )

        if (usable.length === 0) {
            return null
        }

        // Prefer newest (most recent lastActivity)
        return usable.reduce((newest, conn) =>
            conn.getInfo().lastActivity > newest.getInfo().lastActivity
                ? conn
                : newest,
        )
    }

    /**
     * Find the oldest connection in a list
     */
    private findOldestConnection(
        connections: PeerConnection[],
    ): PeerConnection | null {
        if (connections.length === 0) return null

        return connections.reduce((oldest, conn) =>
            conn.getInfo().lastActivity < oldest.getInfo().lastActivity
                ? conn
                : oldest,
        )
    }

    /**
     * Get total connection count across all peers (excluding pending)
     */
    public getTotalConnectionCount(): number {
        let count = 0
        for (const peerConnections of this.connections.values()) {
            count += peerConnections.length
        }
        return count
    }

    /**
     * Close a specific connection and remove from pool
     */
    private async closeConnection(connection: PeerConnection): Promise<void> {
        const info = connection.getInfo()
        const peerConnections = this.connections.get(info.peerIdentity)

        if (peerConnections) {
            const index = peerConnections.indexOf(connection)
            if (index !== -1) {
                peerConnections.splice(index, 1)
            }

            if (peerConnections.length === 0) {
                this.connections.delete(info.peerIdentity)
            }
        }

        await connection.close()
    }

    /**
     * Periodic cleanup of idle and dead connections
     */
    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanupDeadConnections()
        }, POOL_CLEANUP_INTERVAL_MS)
    }

    /**
     * Remove dead and idle connections from pool
     */
    private async cleanupDeadConnections(): Promise<void> {
        const now = Date.now()
        const connectionsToClose: PeerConnection[] = []

        // Clean up authenticated connections
        for (const [
            peerIdentity,
            peerConnections,
        ] of this.connections.entries()) {
            const terminalConnections: PeerConnection[] = []
            const idleTimedOutConnections: PeerConnection[] = []
            const activeConnections: PeerConnection[] = []

            for (const connection of peerConnections) {
                const state = connection.getState()
                const info = connection.getInfo()

                if (ConnectionStateUtils.isTerminal(state)) {
                    terminalConnections.push(connection)
                } else if (
                    state === ConnectionState.IDLE &&
                    info.inFlightCount === 0 &&
                    now - info.lastActivity > this.config.idleTimeout
                ) {
                    idleTimedOutConnections.push(connection)
                } else {
                    activeConnections.push(connection)
                }
            }

            connectionsToClose.push(...terminalConnections)

            // Keep one idle connection per identity to maintain peer presence
            if (
                activeConnections.length === 0 &&
                idleTimedOutConnections.length > 0
            ) {
                connectionsToClose.push(...idleTimedOutConnections.slice(1))
                activeConnections.push(idleTimedOutConnections[0])
            } else {
                connectionsToClose.push(...idleTimedOutConnections)
            }

            if (activeConnections.length === 0) {
                this.connections.delete(peerIdentity)
            } else {
                this.connections.set(peerIdentity, activeConnections)
            }
        }

        // Clean up pending connections that timed out
        for (const [tempId, connection] of this.pendingConnections.entries()) {
            const state = connection.getState()
            const createdAt = connection.getCreatedAt()

            // Remove if terminal or auth timed out
            if (
                ConnectionStateUtils.isTerminal(state) ||
                (state === ConnectionState.PENDING_AUTH &&
                    now - createdAt > this.config.authTimeout)
            ) {
                this.pendingConnections.delete(tempId)
                connectionsToClose.push(connection)
            }
        }

        // Close removed connections
        for (const connection of connectionsToClose) {
            try {
                await connection.close()
            } catch {
                // Ignore errors during cleanup
            }
        }

        if (connectionsToClose.length > 0) {
            log.debug(
                `[ConnectionPool] Cleaned up ${connectionsToClose.length} idle/dead connections`,
            )
        }
    }

    static getInstance(rateLimiter?: RateLimiter): ConnectionPool {
        if (!this.instance && rateLimiter) {
            this.instance = new ConnectionPool(
                structuredClone(DEFAULT_OMNIPROTOCOL_CONFIG.pool),
                rateLimiter,
            )
        }

        if (!this.instance && !rateLimiter) {
            throw new Error("ConnectionPool not initialised: must call getInstance(rateLimiter) before getInstance()")
        }

        return this.instance
    }
}
