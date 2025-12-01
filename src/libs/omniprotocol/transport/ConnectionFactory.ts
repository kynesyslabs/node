import { PeerConnection } from "./PeerConnection"
import { TLSConnection } from "./TLSConnection"
import { parseConnectionString } from "./types"
import type { TLSConfig } from "../tls/types"

/**
 * Factory for creating connections based on protocol
 * Chooses between TCP and TLS based on connection string
 */
export class ConnectionFactory {
    private tlsConfig: TLSConfig | null = null

    constructor(tlsConfig?: TLSConfig) {
        this.tlsConfig = tlsConfig || null
    }

    /**
     * Create connection based on protocol in connection string
     * @param peerIdentity Peer identity
     * @param connectionString Connection string (tcp:// or tls://)
     * @returns PeerConnection or TLSConnection
     */
    createConnection(
        peerIdentity: string,
        connectionString: string,
    ): PeerConnection | TLSConnection {
        const parsed = parseConnectionString(connectionString)

        // Support both tls:// and tcps:// for TLS connections
        if (parsed.protocol === "tls" || parsed.protocol === "tcps") {
            if (!this.tlsConfig) {
                throw new Error(
                    "TLS connection requested but TLS config not provided to factory",
                )
            }

            console.log(
                `[ConnectionFactory] Creating TLS connection to ${peerIdentity} at ${parsed.host}:${parsed.port}`,
            )
            return new TLSConnection(peerIdentity, connectionString, this.tlsConfig)
        } else {
            console.log(
                `[ConnectionFactory] Creating TCP connection to ${peerIdentity} at ${parsed.host}:${parsed.port}`,
            )
            return new PeerConnection(peerIdentity, connectionString)
        }
    }

    /**
     * Update TLS configuration
     */
    setTLSConfig(config: TLSConfig): void {
        this.tlsConfig = config
    }

    /**
     * Get current TLS configuration
     */
    getTLSConfig(): TLSConfig | null {
        return this.tlsConfig
    }
}
