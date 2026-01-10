import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import Chain from "../blockchain/chain"
import eggs from "./routines/eggs"
import { getSharedState } from "src/utilities/sharedState"
import _ from "lodash"
// Importing methods themselves
import getPeerInfo from "./routines/nodecalls/getPeerInfo"
import getPeerlist from "./routines/nodecalls/getPeerlist"
import getPreviousHashFromBlockNumber from "./routines/nodecalls/getPreviousHashFromBlockNumber"
import getPreviousHashFromBlockHash from "./routines/nodecalls/getPreviousHashFromBlockHash"
import getBlockHeaderByNumber from "./routines/nodecalls/getBlockHeaderByNumber"
import getBlockHeaderByHash from "./routines/nodecalls/getBlockHeaderByHash"
import getBlockByNumber from "./routines/nodecalls/getBlockByNumber"
import getBlockByHash from "./routines/nodecalls/getBlockByHash"
import getBlocks from "./routines/nodecalls/getBlocks"
import getTransactions from "./routines/nodecalls/getTransactions"
import Hashing from "../crypto/hashing"
import log from "src/utilities/logger"
import HandleGCR from "../blockchain/gcr/handleGCR"
import isValidatorForNextBlock from "../consensus/v2/routines/isValidator"
import TxUtils from "../blockchain/transaction"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { Twitter } from "../identity/tools/twitter"
import { Tweet } from "@kynesyslabs/demosdk/types"
import Mempool from "../blockchain/mempool_v2"
import ensureGCRForUser from "../blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Discord, DiscordMessage } from "../identity/tools/discord"
import { UDIdentityManager } from "../blockchain/gcr/gcr_routines/udIdentityManager"
// DEPRECATED: GitHub OAuth removed - import { exchangeGitHubCode } from "../identity/oauth/github"
// REVIEW: IPFS NodeCall handlers (Phase 2 + Phase 3 + Phase 4 + Phase 5 + Phase 8)
import {
    ipfsStatus,
    ipfsAdd,
    ipfsGet,
    ipfsPin,
    ipfsUnpin,
    ipfsListPins,
    ipfsPins,
    ipfsAddStream,
    ipfsGetStream,
    // REVIEW: Swarm management (Phase 4)
    ipfsSwarmPeers,
    ipfsSwarmConnect,
    ipfsSwarmDisconnect,
    ipfsBootstrapList,
    ipfsClusterPin,
    ipfsDemosPeers,
    // REVIEW: Public Bridge (Phase 5)
    ipfsPublicFetch,
    ipfsPublicPublish,
    ipfsPublicCheck,
    ipfsRateLimitStatus,
    // REVIEW: Phase 9 - Cost estimation
    ipfsQuote,
    // REVIEW: DEM-480 - Storage quota check
    ipfsQuota,
} from "./routines/nodecalls/ipfs"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { DTRManager } from "./dtr/dtrmanager"

export interface NodeCall {
    message: string
    data: any
    muid: string
}

/**
 * Dispatches an incoming NodeCall message to the appropriate handler and produces an RPCResponse.
 *
 * @param content - NodeCall containing `message` (the RPC action to perform), `data` (payload for the action), and `muid` (message unique id)
 * @param sender - Optional sender public key for authenticated operations (e.g., ipfsQuote)
 * @returns An RPCResponse containing the numeric status, the response payload for the requested action, and optional `extra` diagnostic data
 */
export async function manageNodeCall(content: NodeCall, sender?: string): Promise<RPCResponse> {
    // Basic Node API handling logic
    // ...
    let result: any // Storage for the result
    let nStat: any // Storage for the native status
    const { data } = content
    let response = _.cloneDeep(emptyResponse)
    response.result = 200 // Until proven otherwise
    response.require_reply = false // Until proven otherwise
    response.extra = null // Until proven otherwise
    log.debug("[manageNodeCall] Content: " + JSON.stringify(content))
    switch (content.message) {
        case "getPeerInfo":
            response.response = await getPeerInfo()
            break
        case "getPeerlist":
            response.response = await getPeerlist()
            break
        case "getPeerlistHash":
            var peerlist = await getPeerlist()
            response.response = Hashing.sha256(JSON.stringify(peerlist))
            log.custom(
                "manageNodeCall",
                "Peerlist hash: " + response.response,
                true,
            )
            break
        // REVIEW Both below for getting the last hash (untested yet)
        case "getPreviousHashFromBlockNumber":
            result = await getPreviousHashFromBlockNumber(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getPreviousHashFromBlockHash":
            result = await getPreviousHashFromBlockHash(data)
            response.response = result.response
            response.extra = result.extra
            break
        // REVIEW (untested) Headers instead of full blocks
        case "getBlockHeaderByNumber":
            result = await getBlockHeaderByNumber(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getBlockHeaderByHash":
            result = await getBlockHeaderByHash(data)
            response.response = result.response
            response.extra = result.extra
            break
        case "getLastBlockNumber":
            log.debug("[SERVER] Received getLastBlockNumber")
            response.response = await Chain.getLastBlockNumber()
            log.debug("[CHAIN] Received reply from the database")
            break
        case "getLastBlock":
            response.response = await Chain.getLastBlock()
            break
        case "getLastBlockHash":
            response.response = await Chain.getLastBlockHash()
            break
        case "getBlockByNumber": {
            return await getBlockByNumber(data)
        }
        case "getBlocks":
            return await getBlocks(data)
        case "getTransactions":
            return await getTransactions(data)
        case "getBlockByHash":
            // Check if we have .hash or .blockHash
            if (data.hash) {
                log.debug(`[SERVER] getBlockByHash: ${data.hash}`)
            } else if (data.blockHash) {
                log.debug(`[SERVER] getBlockByHash: ${data.blockHash}`)
                data.hash = data.blockHash
            } else {
                response.result = 400
                response.response = "No hash or blockHash specified"
            }
            try {
                result = await getBlockByHash(data)
                response.response = result.response
                response.extra = result.extra
            } catch (e) {
                response.response = null
                response.result = 400
                response.extra = e
            }
            break
        case "getTxByHash":
            if (!data.hash) {
                response.result = 400
                response.response = "No hash specified"
                break
            }
            log.debug(`[SERVER] getTxByHash: ${data.hash}`)
            try {
                response.response = await Chain.getTxByHash(data.hash)
            } catch (e) {
                response.response = null
                response.result = 400
                response.extra = e
            }
            if (!response.response) {
                response.result = 400
                response.response = "error"
            }
            break

        case "getBlockTransactions": {
            if (!data.blockHash) {
                response.result = 400
                response.response = "No block hash specified"
                break
            }

            response.response = await Chain.getBlockTransactions(data.blockHash)
            break
        }

        case "getMempool":
            response.response = await Mempool.getMempool()
            break
        // INFO Authentication listener
        case "getPeerIdentity":
            // NOTE We don't need to sign anything as the headers are signed already
            response.response = uint8ArrayToHex(
                getSharedState.keypair.publicKey as Uint8Array,
            )
            //console.log(response)
            break

        // INFO Address info endpoint
        case "getAddressInfo":
            if (!data.address) {
                response.result = 400
                response.response = "No address specified"
                break
            }
            try {
                nStat = await ensureGCRForUser(data.address)
                response.response = nStat
            } catch (error) {
                response.result = 400
                response.response = "error"
                response.extra = error
            }
            break
        case "getAddressNonce":
            if (!data.address) {
                response.result = 400
                response.response = "No address specified"
                break
            }
            nStat = await ensureGCRForUser(data.address)
            response.response = nStat.nonce
            break
        case "getPeerTime":
            response.response = new Date().getTime()
            break

        case "getAllTxs":
            // NOTE: Endpoint deprecated
            response.response = {}
            break

        // REVIEW Implement native tables requests
        // NOTE: ...(data.options ? [data.options] : []) is used to handle optional parameters. If the options are not provided, the function will use its default values.
        case "getNativeStatus":
            response = await HandleGCR.getNativeStatus(
                data.address,
                ...(data.options ? [data.options] : []),
            )
            break
        case "getNativeProperties":
            response = await HandleGCR.getNativeProperties(
                data.address,
                ...(data.options ? [data.options] : []),
            )
            break
        case "getNativeSubnetsTxs":
            response = await HandleGCR.getNativeSubnetsTxs(
                data.subnetId,
                ...(data.options ? [data.options] : []),
            )
            break
        case "getTransactionHistory": {
            if (!data.address || !data.type) {
                response.result = 400
                response.response = "No address or type specified"
                break
            }
            response.response = await Chain.getTransactionHistory(
                data.address,
                data.type,
                data.start || 0,
                data.limit || 100,
            )
            break
        }

        case "getTweet": {
            if (!data.tweetUrl) {
                response.result = 400
                response.response = "No tweet URL specified"
                break
            }

            const twitter = Twitter.getInstance()
            let tweet: Tweet = null

            try {
                tweet = await twitter.getTweetByUrl(data.tweetUrl)
            } catch (error) {
                response.result = 400
                response.response = {
                    success: false,
                    error: "Failed to get tweet",
                }
                break
            }

            response.result = tweet ? 200 : 400
            if (tweet) {
                const data = {
                    id: (tweet as any).id,
                    created_at: tweet.created_at,
                    text: tweet.text,
                    username: tweet.author.screen_name,
                    userId: tweet.author.rest_id,
                }
                response.response = {
                    tweet: data,
                    success: true,
                }
            } else {
                response.response = {
                    success: false,
                    error: "Failed to get tweet",
                }
            }
            break
        }

        case "resolveUdDomain": {
            try {
                const res = await UDIdentityManager.resolveUDDomain(data.domain)

                if (res) {
                    response.response = res
                }
            } catch (error) {
                log.error("[manageNodeCall] Failed to resolve web3 domain: " + error)
                response.result = 400
                response.response = {
                    success: false,
                    error: "Failed to resolve web3 domain",
                }
            }
            break
        }

        case "getDiscordMessage": {
            if (!data.discordUrl) {
                response.result = 400
                response.response = "No Discord URL specified"
                break
            }

            let discord: Discord
            try {
                discord = Discord.getInstance()
            } catch (e) {
                response.result = 500
                response.response = {
                    success: false,
                    error: "Discord not configured",
                }
                break
            }

            let message: DiscordMessage | null = null

            try {
                message = await discord.getMessageByUrl(data.discordUrl)
            } catch (error) {
                response.result = 400
                response.response = {
                    success: false,
                    error: "Failed to get Discord message",
                }
                break
            }

            response.result = message ? 200 : 400
            if (message) {
                let guildIdFromUrl: string | undefined
                let channelIdFromUrl: string | undefined
                let messageIdFromUrl: string | undefined

                try {
                    const details = discord.extractMessageDetails(
                        data.discordUrl,
                    )
                    guildIdFromUrl = details.guildId
                    channelIdFromUrl = details.channelId
                    messageIdFromUrl = details.messageId
                } catch {
                    // non-fatal, e.g. if URL format was unexpected
                }

                const payload = {
                    id: message.id,
                    timestamp: message.timestamp,
                    authorUsername: message.author?.username ?? null,
                    authorId: message.author?.id ?? null,
                    channelId: message.channel_id ?? channelIdFromUrl ?? null,
                    guildId:
                        (message as any).guild_id ?? guildIdFromUrl ?? null,
                }

                response.response = {
                    message: payload,
                    success: true,
                }
            } else {
                response.response = {
                    success: false,
                    error: "Failed to get Discord message",
                }
            }
            break
        }

        // INFO: Tests if twitter account is a bot
        // case "checkIsBot": {
        //     if (!data.username || !data.userId) {
        //         response.result = 400
        //         response.response = "No username or userId specified"
        //         break
        //     }

        //     response.response = await Twitter.getInstance().checkIsBot(
        //         data.username,
        //         data.userId,
        //     )
        //     break
        // }

        // case "getFlaggedAccounts": {
        //     log.only("getFlaggedAccounts")
        //     log.only(JSON.stringify(data))
        //     if (data.start === undefined || data.end === undefined) {
        //         response.result = 400
        //         response.response = "No start or end specified"
        //         break
        //     }

        //     // INFO: Verify signature
        //     const isVerified = await ucrypto.verify({
        //         algorithm: "ed25519",
        //         message: new TextEncoder().encode("demos"),
        //         publicKey: hexToUint8Array(process.env.SUDO_PUBKEY),
        //         signature: hexToUint8Array(data.signature),
        //     })

        //     if (!isVerified) {
        //         response.result = 400
        //         response.response = "Invalid public key on protected endpoint"
        //         break
        //     }

        //     response.response = await GCR.getFlaggedAccounts(
        //         data.start,
        //         data.end,
        //     )
        //     break
        // }

        // case "removeAccount": {
        //     if (!data.address) {
        //         response.result = 400
        //         response.response = "No address specified"
        //         break
        //     }

        //     // INFO: Verify signature
        //     const isVerified = await ucrypto.verify({
        //         algorithm: "ed25519",
        //         message: new TextEncoder().encode("demos"),
        //         publicKey: hexToUint8Array(process.env.SUDO_PUBKEY),
        //         signature: hexToUint8Array(data.signature),
        //     })

        //     if (!isVerified) {
        //         response.result = 400
        //         response.response = "Invalid public key on protected endpoint"
        //         break
        //     }

        //     const result = await GCR.removeAccount(data.address)
        //     response.result = result ? 200 : 400
        //     response.response = result ? "Account removed" : "Account not found"
        //     break
        // }

        // case "unflagAccount": {
        //     if (!data.address) {
        //         response.result = 400
        //         response.response = "No address specified"
        //         break
        //     }

        //     // INFO: Verify signature
        //     const isVerified = await ucrypto.verify({
        //         algorithm: "ed25519",
        //         message: new TextEncoder().encode("demos"),
        //         publicKey: hexToUint8Array(process.env.SUDO_PUBKEY),
        //         signature: hexToUint8Array(data.signature),
        //     })

        //     if (!isVerified) {
        //         response.result = 400
        //         response.response = "Invalid public key on protected endpoint"
        //         break
        //     }

        //     const result = await GCR.unflagAccount(data.address)
        //     response.result = result ? 200 : 400
        //     response.response = result
        //         ? "Account unflagged"
        //         : "Account not found"
        //     break
        // }

        // =========================================================================
        // REVIEW: IPFS Operations (Phase 2)
        // =========================================================================
        case "ipfsStatus":
            return await ipfsStatus()

        case "ipfsAdd":
            return await ipfsAdd(data)

        case "ipfsGet":
            return await ipfsGet(data)

        case "ipfsPin":
            return await ipfsPin(data)

        case "ipfsUnpin":
            return await ipfsUnpin(data)

        case "ipfsListPins":
            return await ipfsListPins()

        // REVIEW: Account-based pins query (Phase 3)
        case "ipfsPins":
            return await ipfsPins(data)

        // REVIEW: Streaming endpoints for large files (Phase 8)
        case "ipfsAddStream":
            return await ipfsAddStream(data)

        case "ipfsGetStream":
            return await ipfsGetStream(data)

        // REVIEW: Swarm management endpoints (Phase 4)
        case "ipfsSwarmPeers":
            return await ipfsSwarmPeers()

        case "ipfsSwarmConnect":
            return await ipfsSwarmConnect(data)

        case "ipfsSwarmDisconnect":
            return await ipfsSwarmDisconnect(data)

        case "ipfsBootstrapList":
            return await ipfsBootstrapList()

        case "ipfsClusterPin":
            return await ipfsClusterPin(data)

        case "ipfsDemosPeers":
            return await ipfsDemosPeers()

        // REVIEW: Public Bridge endpoints (Phase 5)
        case "ipfsPublicFetch":
            return await ipfsPublicFetch(data)

        case "ipfsPublicPublish":
            return await ipfsPublicPublish(data)

        case "ipfsPublicCheck":
            return await ipfsPublicCheck(data)

        case "ipfsRateLimitStatus":
            return await ipfsRateLimitStatus()

        // REVIEW: Phase 9 - Cost estimation endpoint
        case "ipfsQuote":
            return await ipfsQuote(data, sender)

        // REVIEW: DEM-480 - Storage quota check endpoint
        case "ipfsQuota":
            return await ipfsQuota(data)

        // =========================================================================
        // REVIEW: TLSNotary Operations
        // =========================================================================

        // REVIEW: TLSNotary proxy request endpoint for SDK (requires valid token)
        case "requestTLSNproxy": {
            try {
                const { requestProxy, ProxyError } = await import("@/features/tlsnotary/proxyManager")
                const { validateToken, consumeRetry } = await import("@/features/tlsnotary/tokenManager")

                // Require tokenId and owner (pubkey) for paid access
                if (!data.tokenId || !data.owner) {
                    response.result = 400
                    response.response = {
                        error: "INVALID_REQUEST",
                        message: "Missing tokenId or owner parameter",
                    }
                    break
                }

                if (!data.targetUrl) {
                    response.result = 400
                    response.response = {
                        error: "INVALID_REQUEST",
                        message: "Missing targetUrl parameter",
                    }
                    break
                }

                // Validate URL is HTTPS
                if (!data.targetUrl.startsWith("https://")) {
                    response.result = 400
                    response.response = {
                        error: ProxyError.INVALID_URL,
                        message: "Only HTTPS URLs are supported for TLS attestation",
                    }
                    break
                }

                // Validate the token
                const validation = validateToken(data.tokenId, data.owner, data.targetUrl)
                if (!validation.valid) {
                    response.result = validation.error === "TOKEN_NOT_FOUND" ? 404 : 403
                    response.response = {
                        error: validation.error,
                        message: `Token validation failed: ${validation.error}`,
                        domain: validation.token?.domain, // Show expected domain on mismatch
                    }
                    break
                }

                // Request the proxy (this spawns wstcp if needed)
                const result = await requestProxy(data.targetUrl, data.requestOrigin)

                if ("error" in result) {
                    // Map proxy errors to appropriate HTTP status codes
                    switch (result.error) {
                        case ProxyError.INVALID_URL:
                            response.result = 400 // Bad Request - client error
                            break
                        case ProxyError.PORT_EXHAUSTED:
                            response.result = 503 // Service Unavailable - temporary
                            break
                        case ProxyError.WSTCP_NOT_AVAILABLE:
                        case ProxyError.PROXY_SPAWN_FAILED:
                        default:
                            response.result = 500 // Internal Server Error
                            break
                    }
                    response.response = result
                } else {
                    // Success - consume a retry and link proxyId to token
                    const updatedToken = consumeRetry(data.tokenId, result.proxyId)
                    if (updatedToken) {
                        log.info(`[TLSNotary] Proxy spawned for token ${data.tokenId}, retries left: ${updatedToken.retriesLeft}`)
                    }

                    // Add token info to response
                    response.response = {
                        ...result,
                        tokenId: data.tokenId,
                        retriesLeft: updatedToken?.retriesLeft ?? 0,
                    }
                }
            } catch (error) {
                log.error("[manageNodeCall] requestTLSNproxy error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to request TLSNotary proxy",
                }
            }
            break
        }

        // REVIEW: TLSNotary discovery endpoint for SDK auto-configuration
        case "tlsnotary.getInfo": {
            // Dynamic import to avoid circular dependencies and check if enabled
            try {
                const { getTLSNotaryService } = await import("@/features/tlsnotary")
                const service = getTLSNotaryService()

                if (!service || !service.isRunning()) {
                    response.result = 503
                    response.response = {
                        success: false,
                        error: "TLSNotary service is not enabled or not running",
                    }
                    break
                }

                const publicKey = service.getPublicKeyHex()
                const port = service.getPort()

                const proxyPort = process.env.TLSNOTARY_PROXY_PORT ?? "55688"

                // Extract host and determine WebSocket scheme from exposedUrl
                // The node's host is used - SDK connects to the same host it's already connected to
                let nodeHost = "localhost"
                const wsScheme = (() => {
                    try {
                        const exposedUrl = getSharedState.exposedUrl
                        if (exposedUrl) {
                            const url = new URL(exposedUrl)
                            nodeHost = url.hostname
                            return url.protocol === "https:" ? "wss" : "ws"
                        }
                    } catch {
                        // Fall back to localhost and ws if URL parsing fails
                    }
                    return "ws"
                })()

                // Build the notary WebSocket URL - Port is the TLSNotary WebSocket port
                const notaryUrl = `${wsScheme}://${nodeHost}:${port}`

                // WebSocket proxy URL for TCP tunneling
                const proxyUrl = `${wsScheme}://${nodeHost}:${proxyPort}`

                response.response = {
                    notaryUrl,
                    proxyUrl,
                    publicKey,
                    version: "0.1.0", // TLSNotary integration version
                }
            } catch (error) {
                log.error("[manageNodeCall] tlsnotary.getInfo error: " + error)
                response.result = 500
                response.response = {
                    success: false,
                    error: "Failed to get TLSNotary info",
                }
            }
            break
        }

        // REVIEW: TLSNotary token lookup by transaction hash
        case "tlsnotary.getToken": {
            try {
                const { getTokenByTxHash, getToken } = await import("@/features/tlsnotary/tokenManager")

                // Support lookup by either tokenId or txHash
                const { tokenId, txHash } = data as { tokenId?: string; txHash?: string }

                let token
                if (tokenId) {
                    token = getToken(tokenId)
                } else if (txHash) {
                    token = getTokenByTxHash(txHash)
                } else {
                    response.result = 400
                    response.response = {
                        error: "INVALID_REQUEST",
                        message: "Either tokenId or txHash is required",
                    }
                    break
                }

                if (!token) {
                    response.result = 404
                    response.response = {
                        error: "TOKEN_NOT_FOUND",
                        message: "No token found for the provided identifier",
                    }
                } else {
                    response.response = {
                        token: {
                            id: token.id,
                            owner: token.owner,
                            domain: token.domain,
                            status: token.status,
                            expiresAt: token.expiresAt,
                            retriesLeft: token.retriesLeft,
                        },
                    }
                }
            } catch (error) {
                log.error("[manageNodeCall] tlsnotary.getToken error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to get token",
                }
            }
            break
        }

        // REVIEW: TLSNotary token stats for monitoring
        case "tlsnotary.getTokenStats": {
            try {
                const { getTokenStats } = await import("@/features/tlsnotary/tokenManager")
                const stats = getTokenStats()
                response.response = { stats }
            } catch (error) {
                log.error("[manageNodeCall] tlsnotary.getTokenStats error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to get token stats",
                }
            }
            break
        }

        // NOTE Don't look past here, go away
        // INFO For real, nothing here to be seen
        // REVIEW DTR: Handle relayed transactions from non-validator nodes
        case "RELAY_TX":
            return await DTRManager.receiveRelayedTransactions(
                data as ValidityData[],
            )
        case "hots":
            log.debug("[SERVER] Received hots")
            response.response = eggs.hots()
            break

        default:
            log.warning("[SERVER] Received unknown message")
            // eslint-disable-next-line quotes
            response.response = '{ error: "Unknown message"}'
            break
    }

    // REVIEW Is this ok? Follow back and see
    return response
}
