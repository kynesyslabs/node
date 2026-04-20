/**
 * OmniProtocol Peer Adapter
 *
 * Adapts Peer RPC calls to use OmniProtocol TCP transport instead of HTTP.
 * Extends BaseOmniAdapter for shared utilities.
 */

import log from "src/utilities/logger"
import { handleError } from "src/errors"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import Peer, { CallOptions } from "src/libs/peer/Peer"

import { BaseOmniAdapter, BaseAdapterOptions } from "./BaseAdapter"
import {
    encodeNodeCallRequest,
    decodeNodeCallResponse,
} from "../serialization/control"
import { OmniOpcode } from "../protocol/opcodes"
import { getSharedState } from "@/utilities/sharedState"

export type AdapterOptions = BaseAdapterOptions

export class PeerOmniAdapter extends BaseOmniAdapter {
    constructor(options: AdapterOptions = {}) {
        super(options)
    }

    /**
     * Adapt a peer RPC call to use OmniProtocol
     * Falls back to HTTP if OmniProtocol fails or is not enabled for peer
     */
    async adaptCall(
        peer: Peer,
        request: RPCRequest,
        isAuthenticated = true,
    ): Promise<RPCResponse> {
        if (!this.shouldUseOmni(peer.identity)) {
            // Use httpCall directly to avoid recursion through call()
            return peer.httpCall(request, isAuthenticated)
        }

        // REVIEW Wave 8.1: TCP transport implementation with ConnectionPool
        try {
            // For self-calls, always use localhost to avoid going through the
            // public URL — the node may be unreachable from outside under load.
            let tcpConnectionString: string
            if (peer.isLocalNode) {
                const omniPort = getSharedState.omniConfig.port
                tcpConnectionString = `${this.getTcpProtocol()}://127.0.0.1:${omniPort}`
            } else {
                tcpConnectionString = this.httpToTcpConnectionString(
                    peer.connection.string,
                )
            }

            // Encode RPC request as binary NodeCall format
            const payload = encodeNodeCallRequest({
                method: request.method,
                params: request.params ?? [],
            })

            // If authenticated, use sendAuthenticated with node's keys
            let responseBuffer: Buffer

            if (isAuthenticated) {
                const privateKey = this.getPrivateKey()
                const publicKey = this.getPublicKey()

                if (!privateKey || !publicKey) {
                    log.warning(
                        "[PeerOmniAdapter] Node keys not available, falling back to HTTP",
                    )
                    // Use httpCall directly to avoid recursion through call()
                    return peer.httpCall(request, isAuthenticated)
                }

                // Send authenticated via OmniProtocol
                responseBuffer = await this.connectionPool.sendAuthenticated(
                    peer.identity,
                    tcpConnectionString,
                    OmniOpcode.NODE_CALL,
                    payload,
                    privateKey,
                    publicKey,
                    {
                        timeout: 30000, // 30 second timeout
                    },
                )
            } else {
                // Send unauthenticated via OmniProtocol
                responseBuffer = await this.connectionPool.send(
                    peer.identity,
                    tcpConnectionString,
                    OmniOpcode.NODE_CALL,
                    payload,
                    {
                        timeout: 30000, // 30 second timeout
                    },
                )
            }

            // Decode response from binary NodeCall format
            const decoded = decodeNodeCallResponse(responseBuffer)
            return {
                result: decoded.status,
                response: decoded.value,
                require_reply: decoded.requireReply,
                extra: decoded.extra,
            }
        } catch (error) {
            handleError(error, "NETWORK", { source: "OmniProtocol PeerAdapter.adaptCall" })
            // Check for fatal mode - will exit if OMNI_FATAL=true
            this.handleFatalError(
                error,
                `OmniProtocol failed for peer ${peer.identity}`,
            )

            // On OmniProtocol failure, fall back to HTTP
            log.warning(
                `[PeerOmniAdapter] OmniProtocol failed for ${peer.identity}, falling back to HTTP: ` +
                    error,
            )

            // Mark peer as HTTP-only to avoid repeated TCP failures
            this.markHttpPeer(peer.identity)

            // Use httpCall directly to avoid recursion through call()
            return peer.httpCall(request, isAuthenticated)
        }
    }

    /**
     * Adapt a long-running peer RPC call with retries
     * Currently delegates to standard longCall - OmniProtocol retry logic TBD
     */
    async adaptLongCall(
        peer: Peer,
        request: RPCRequest,
        isAuthenticated = true,
        options?: CallOptions,
    ): Promise<RPCResponse> {
        if (!this.shouldUseOmni(peer.identity)) {
            return peer.longCall(request, isAuthenticated, options)
        }

        // REVIEW: For now, delegate to standard longCall
        // Future: Implement OmniProtocol-native retry with connection reuse
        return peer.longCall(request, isAuthenticated, options)
    }
}
