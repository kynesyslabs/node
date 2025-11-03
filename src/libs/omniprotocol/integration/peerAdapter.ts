import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"

import {
    DEFAULT_OMNIPROTOCOL_CONFIG,
    MigrationMode,
    OmniProtocolConfig,
} from "../types/config"
import { ConnectionPool } from "../transport/ConnectionPool"
import { encodeJsonRequest, decodeRpcResponse } from "../serialization/jsonEnvelope"
import { OmniOpcode } from "../protocol/opcodes"

export interface AdapterOptions {
    config?: OmniProtocolConfig
}

function cloneConfig(config: OmniProtocolConfig): OmniProtocolConfig {
    return {
        pool: { ...config.pool },
        migration: {
            ...config.migration,
            omniPeers: new Set(config.migration.omniPeers),
        },
        protocol: { ...config.protocol },
    }
}

/**
 * Convert HTTP(S) URL to TCP connection string
 * @param httpUrl HTTP URL (e.g., "http://localhost:3000" or "https://node.demos.network")
 * @returns TCP connection string (e.g., "tcp://localhost:3000")
 */
function httpToTcpConnectionString(httpUrl: string): string {
    const url = new URL(httpUrl)
    const protocol = "tcp" // Wave 8.1: Use plain TCP, TLS support in Wave 8.5
    const host = url.hostname
    const port = url.port || (url.protocol === "https:" ? "443" : "80")

    return `${protocol}://${host}:${port}`
}

export class PeerOmniAdapter {
    private readonly config: OmniProtocolConfig
    private readonly connectionPool: ConnectionPool

    constructor(options: AdapterOptions = {}) {
        this.config = cloneConfig(
            options.config ?? DEFAULT_OMNIPROTOCOL_CONFIG,
        )

        // Initialize ConnectionPool with configuration
        this.connectionPool = new ConnectionPool({
            maxTotalConnections: this.config.pool.maxTotalConnections,
            maxConnectionsPerPeer: this.config.pool.maxConnectionsPerPeer,
            idleTimeout: this.config.pool.idleTimeout,
            connectTimeout: this.config.pool.connectTimeout,
            authTimeout: this.config.pool.authTimeout,
        })
    }

    get migrationMode(): MigrationMode {
        return this.config.migration.mode
    }

    set migrationMode(mode: MigrationMode) {
        this.config.migration.mode = mode
    }

    get omniPeers(): Set<string> {
        return this.config.migration.omniPeers
    }

    shouldUseOmni(peerIdentity: string): boolean {
        const { mode, omniPeers } = this.config.migration

        switch (mode) {
            case "HTTP_ONLY":
                return false
            case "OMNI_PREFERRED":
                return omniPeers.has(peerIdentity)
            case "OMNI_ONLY":
                return true
            default:
                return false
        }
    }

    markOmniPeer(peerIdentity: string): void {
        this.config.migration.omniPeers.add(peerIdentity)
    }

    markHttpPeer(peerIdentity: string): void {
        this.config.migration.omniPeers.delete(peerIdentity)
    }

    async adaptCall(
        peer: Peer,
        request: RPCRequest,
        isAuthenticated = true,
    ): Promise<RPCResponse> {
        if (!this.shouldUseOmni(peer.identity)) {
            return peer.call(request, isAuthenticated)
        }

        // REVIEW Wave 8.1: TCP transport implementation with ConnectionPool
        try {
            // Convert HTTP URL to TCP connection string
            const tcpConnectionString = httpToTcpConnectionString(peer.connection.string)

            // Encode RPC request as JSON envelope
            const payload = encodeJsonRequest(request)

            // Send via OmniProtocol (opcode 0x03 = NODE_CALL)
            const responseBuffer = await this.connectionPool.send(
                peer.identity,
                tcpConnectionString,
                OmniOpcode.NODE_CALL,
                payload,
                {
                    timeout: 30000, // 30 second timeout
                },
            )

            // Decode response from RPC envelope
            const response = decodeRpcResponse(responseBuffer)
            return response
        } catch (error) {
            // On OmniProtocol failure, fall back to HTTP
            console.warn(
                `[PeerOmniAdapter] OmniProtocol failed for ${peer.identity}, falling back to HTTP:`,
                error,
            )

            // Mark peer as HTTP-only to avoid repeated TCP failures
            this.markHttpPeer(peer.identity)

            return peer.call(request, isAuthenticated)
        }
    }

    async adaptLongCall(
        peer: Peer,
        request: RPCRequest,
        isAuthenticated = true,
        sleepTime = 1000,
        retries = 3,
        allowedErrors: number[] = [],
    ): Promise<RPCResponse> {
        if (!this.shouldUseOmni(peer.identity)) {
            return peer.longCall(
                request,
                isAuthenticated,
                sleepTime,
                retries,
                allowedErrors,
            )
        }

        return peer.longCall(
            request,
            isAuthenticated,
            sleepTime,
            retries,
            allowedErrors,
        )
    }
}

export default PeerOmniAdapter

