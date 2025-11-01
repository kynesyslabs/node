import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import Peer from "src/libs/peer/Peer"

import {
    DEFAULT_OMNIPROTOCOL_CONFIG,
    MigrationMode,
    OmniProtocolConfig,
} from "../types/config"

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

export class PeerOmniAdapter {
    private readonly config: OmniProtocolConfig

    constructor(options: AdapterOptions = {}) {
        this.config = cloneConfig(
            options.config ?? DEFAULT_OMNIPROTOCOL_CONFIG,
        )
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

        // Wave 7.1 placeholder: direct HTTP fallback while OmniProtocol
        // transport is scaffolded. Future waves will replace this branch
        // with binary encoding + TCP transport.
        return peer.call(request, isAuthenticated)
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

