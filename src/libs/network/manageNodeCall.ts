import { RPCResponse, SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import { emptyResponse } from "./server_rpc"
import Chain from "../blockchain/chain"
import fs from "fs"
import eggs from "./routines/eggs"
import { getSharedState } from "src/utilities/sharedState"
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
import getTxsByHashes from "./routines/nodecalls/getTxsByHashes"
import Hashing from "../crypto/hashing"
import log from "src/utilities/logger"
import HandleGCR from "../blockchain/gcr/handleGCR"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import isValidatorForNextBlock from "../consensus/v2/routines/isValidator"
import L2PSMempool from "../blockchain/l2ps_mempool"
import TxUtils from "../blockchain/transaction"
import { Transaction, ValidityData } from "@kynesyslabs/demosdk/types"
import { Twitter } from "../identity/tools/twitter"
import { Tweet } from "@kynesyslabs/demosdk/types"
import Mempool from "../blockchain/mempool_v2"
import ensureGCRForUser from "../blockchain/gcr/gcr_routines/ensureGCRForUser"
import { Discord, DiscordMessage } from "../identity/tools/discord"
import { UDIdentityManager } from "../blockchain/gcr/gcr_routines/udIdentityManager"
import {
    hexToUint8Array,
    ucrypto,
    uint8ArrayToHex,
} from "@kynesyslabs/demosdk/encryption"
import { DTRManager } from "./dtr/dtrmanager"
import { scriptExecutor } from "@/libs/scripting"
import { GCRToken } from "@/model/entities/GCRv2/GCR_Token"
import { dataSource } from "@/model/datasource"

export interface NodeCall {
    message: string
    data: any
    muid: string
}

/**
 * Dispatches an incoming NodeCall message to the appropriate handler and produces an RPCResponse.
 *
 * @param content - NodeCall containing `message` (the RPC action to perform), `data` (payload for the action), and `muid` (message unique id)
 * @returns An RPCResponse containing the numeric status, the response payload for the requested action, and optional `extra` diagnostic data
 */
export async function manageNodeCall(content: NodeCall): Promise<RPCResponse> {
    // Basic Node API handling logic
    // ...
    let result: any // Storage for the result
    let nStat: any // Storage for the native status
    const { data } = content
    let response = structuredClone(emptyResponse)
    response.result = 200 // Until proven otherwise
    response.require_reply = false // Until proven otherwise
    response.extra = null // Until proven otherwise
    log.debug("[manageNodeCall] Content: " + JSON.stringify(content))
    switch (content.message) {
        case "getPeerInfo":
            response.response = await getPeerInfo()
            break
        case "getGenesisDataHash": {
            try {
                const genesisBlock = await Chain.getGenesisBlock().catch(() => null)
                let genesisData =
                    genesisBlock?.content?.extra?.genesisData || null

                if (typeof genesisData === "string") {
                    genesisData = JSON.parse(genesisData)
                }

                // During early startup the genesis block may not be persisted yet; fall back to local genesis file
                // so peer bootstrap doesn't fail with a transient 500.
                if (!genesisData) {
                    const genesisFile = "data/genesis.json"
                    genesisData = JSON.parse(fs.readFileSync(genesisFile, "utf8"))
                }

                response.response = Hashing.sha256(JSON.stringify(genesisData))
                break
            } catch (error) {
                log.error(
                    "[manageNodeCall] Failed to get genesis data hash: " +
                        error,
                )
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to get genesis data hash",
                }
            }
            break
        }

        case "getPeerlist":
            response.response = await getPeerlist()
            break
        case "getPeerlistHash": {
            let peerlist = await getPeerlist()
            response.response = Hashing.sha256(JSON.stringify(peerlist))
            log.custom(
                "manageNodeCall",
                "Peerlist hash: " + response.response,
                true,
            )
            break
        }
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
        case "getTxsByHashes":
            return await getTxsByHashes(data)

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
                log.error(
                    "[manageNodeCall] Failed to resolve web3 domain: " + error,
                )
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

        // REVIEW: TLSNotary proxy request endpoint for SDK (requires valid token)
        case "requestTLSNproxy": {
            try {
                const { requestProxy, ProxyError } = await import(
                    "@/features/tlsnotary/proxyManager"
                )
                const { validateToken, consumeRetry } = await import(
                    "@/features/tlsnotary/tokenManager"
                )

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
                        message:
                            "Only HTTPS URLs are supported for TLS attestation",
                    }
                    break
                }

                // Validate the token
                const validation = validateToken(
                    data.tokenId,
                    data.owner,
                    data.targetUrl,
                )
                if (!validation.valid) {
                    response.result =
                        validation.error === "TOKEN_NOT_FOUND" ? 404 : 403
                    response.response = {
                        error: validation.error,
                        message: `Token validation failed: ${validation.error}`,
                        domain: validation.token?.domain, // Show expected domain on mismatch
                    }
                    break
                }

                // Request the proxy (this spawns wstcp if needed)
                const result = await requestProxy(
                    data.targetUrl,
                    data.requestOrigin,
                )

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
                    const updatedToken = consumeRetry(
                        data.tokenId,
                        result.proxyId,
                    )
                    if (updatedToken) {
                        log.info(
                            `[TLSNotary] Proxy spawned for token ${data.tokenId}, retries left: ${updatedToken.retriesLeft}`,
                        )
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
                const { getTLSNotaryService } = await import(
                    "@/features/tlsnotary"
                )
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
                const { getTokenByTxHash, getToken } = await import(
                    "@/features/tlsnotary/tokenManager"
                )

                // Support lookup by either tokenId or txHash
                const { tokenId, txHash } = data as {
                    tokenId?: string
                    txHash?: string
                }

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
                const { getTokenStats } = await import(
                    "@/features/tlsnotary/tokenManager"
                )
                const stats = getTokenStats()
                response.response = { stats }
            } catch (error) {
                log.error(
                    "[manageNodeCall] tlsnotary.getTokenStats error: " + error,
                )
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to get token stats",
                }
            }
            break
        }

        // REVIEW L2PS: Node-to-node communication for L2PS mempool synchronization
        case "getL2PSParticipationById":
            console.log("[L2PS] Received L2PS participation query")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }
            try {
                // Check if this node participates in the specified L2PS network
                const joinedUIDs = getSharedState.l2psJoinedUids || []
                const isParticipating = joinedUIDs.includes(data.l2psUid)

                response.result = 200
                response.response = {
                    participating: isParticipating,
                    l2psUid: data.l2psUid,
                    nodeIdentity: getSharedState.publicKeyHex,
                }

                log.debug(`[L2PS] Participation query for ${data.l2psUid}: ${isParticipating}`)
            } catch (error) {
                log.error("[L2PS] Error checking L2PS participation:", error)
                response.result = 500
                response.response = "Internal error checking L2PS participation"
            }
            break

        case "getL2PSMempoolInfo": {
            // REVIEW: Phase 3c-1 - L2PS mempool info endpoint
            console.log("[L2PS] Received L2PS mempool info request")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }

            try {
                // Get all processed transactions for this L2PS UID
                const transactions = await L2PSMempool.getByUID(data.l2psUid, "processed")

                response.result = 200
                response.response = {
                    l2psUid: data.l2psUid,
                    transactionCount: transactions.length,
                    lastTimestamp: transactions.at(-1)?.timestamp ?? 0,
                    oldestTimestamp: transactions.at(0)?.timestamp ?? 0,
                }
            } catch (error: any) {
                log.error("[L2PS] Failed to get mempool info:", error)
                response.result = 500
                response.response = "Failed to get L2PS mempool info"
                response.extra = error.message || "Internal error"
            }
            break
        }

        case "getL2PSTransactions": {
            // REVIEW: Phase 3c-1 - L2PS transactions sync endpoint
            console.log("[L2PS] Received L2PS transactions sync request")
            if (!data.l2psUid) {
                response.result = 400
                response.response = "No L2PS UID specified"
                break
            }

            try {
                // Optional timestamp filter for incremental sync
                const sinceTimestamp = data.since_timestamp || 0

                // Get all processed transactions for this L2PS UID
                let transactions = await L2PSMempool.getByUID(data.l2psUid, "processed")

                // Filter by timestamp if provided (incremental sync)
                if (sinceTimestamp > 0) {
                    transactions = transactions.filter(tx => tx.timestamp > sinceTimestamp)
                }

                // Return encrypted transactions (validators never see this)
                // Only L2PS participants can decrypt
                response.result = 200
                response.response = {
                    l2psUid: data.l2psUid,
                    transactions: transactions.map(tx => ({
                        hash: tx.hash,
                        l2ps_uid: tx.l2ps_uid,
                        original_hash: tx.original_hash,
                        encrypted_tx: tx.encrypted_tx,
                        timestamp: tx.timestamp,
                        block_number: tx.block_number,
                    })),
                    count: transactions.length,
                }
            } catch (error: any) {
                log.error("[L2PS] Failed to get transactions:", error)
                response.result = 500
                response.response = "Failed to get L2PS transactions"
                response.extra = error.message || "Internal error"
            }
            break
        }

        case "getL2PSAccountTransactions": {
            // L2PS transaction history for a specific account
            // REQUIRES AUTHENTICATION: User must sign a message to prove address ownership
            console.log("[L2PS] Received account transactions request")
            if (!data.l2psUid || !data.address) {
                response.result = 400
                response.response = "L2PS UID and address are required"
                break
            }

            // Verify ownership via signature
            // User must provide: signature of message "getL2PSHistory:{address}:{timestamp}"
            if (!data.signature || !data.timestamp) {
                response.result = 401
                response.response = "Authentication required. Provide signature and timestamp."
                response.extra = {
                    message: "Sign the message 'getL2PSHistory:{address}:{timestamp}' with your wallet",
                    example: `getL2PSHistory:${data.address}:${Date.now()}`
                }
                break
            }

            // Validate timestamp (max 5 minutes old to prevent replay attacks)
            const requestTime = Number.parseInt(data.timestamp, 10)
            const now = Date.now()
            if (Number.isNaN(requestTime) || now - requestTime > 5 * 60 * 1000 || requestTime > now + 60 * 1000) {
                response.result = 401
                response.response = "Request expired or invalid timestamp."
                break
            }

            try {
                // Verify signature using Cryptography class
                const expectedMessage = `getL2PSHistory:${data.address}:${data.timestamp}`

                // Import Cryptography for signature verification
                const Cryptography = (await import("../crypto/cryptography")).default

                // Address should be hex public key, signature should be hex
                let signature = data.signature
                let publicKey = data.address

                // Remove 0x prefix if present
                if (signature.startsWith("0x")) signature = signature.slice(2)
                if (publicKey.startsWith("0x")) publicKey = publicKey.slice(2)

                // Verify signature - wrap in try-catch as invalid format throws
                let isValid = false
                try {
                    isValid = Cryptography.verify(expectedMessage, signature, publicKey)
                } catch (verifyError: any) {
                    log.warning(`[L2PS] Signature verification error: ${verifyError.message}`)
                    // Invalid signature format - treat as auth failure
                    isValid = false
                }

                if (!isValid) {
                    response.result = 403
                    response.response = "Invalid signature. Unable to verify address ownership."
                    break
                }

                // Signature verified - user owns this address
                log.info(`[L2PS] Authenticated request for ${data.address.slice(0, 16)}...`)

                const maxLimit = 1000
                const limit = Math.min(Math.max(1, data.limit || 100), maxLimit)
                const offset = Math.max(0, data.offset || 0)

                // Import the executor to get account transactions
                const { default: L2PSTransactionExecutor } = await import("../l2ps/L2PSTransactionExecutor")
                const transactions = await L2PSTransactionExecutor.getAccountTransactions(
                    data.l2psUid,
                    data.address,
                    limit,
                    offset
                )

                response.result = 200
                response.response = {
                    l2psUid: data.l2psUid,
                    address: data.address,
                    authenticated: true,
                    transactions: transactions.map(tx => {
                        // Extract message from transaction content if execution_message is not set
                        // Content structure: data[1].message
                        let txMessage = tx.execution_message
                        if (!txMessage && tx.content?.data?.[1]?.message) {
                            txMessage = tx.content.data[1].message
                        }

                        return {
                            hash: tx.hash,
                            encrypted_hash: tx.encrypted_hash,
                            l1_batch_hash: tx.l1_batch_hash,
                            type: tx.type,
                            from: tx.from_address,
                            to: tx.to_address,
                            amount: tx.amount?.toString() || "0",
                            status: tx.status,
                            timestamp: tx.timestamp?.toString() || "0",
                            l1_block_number: tx.l1_block_number,
                            execution_message: txMessage
                        }
                    }),
                    count: transactions.length,
                    hasMore: transactions.length === limit
                }
            } catch (error: any) {
                log.error("[L2PS] Failed to get account transactions:", error)
                response.result = 500
                response.response = "Failed to get L2PS account transactions"
                response.extra = error.message || "Internal error"
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

        // REVIEW: Crypto readiness probe (used by perf harness to avoid early-startup tx validation crashes)
        case "crypto.getIdentity": {
            try {
                const algo = (data?.algorithm as SigningAlgorithm) || getSharedState.signingAlgorithm
                const identity = await ucrypto.getIdentity(algo)
                response.result = 200
                response.response = {
                    algorithm: algo,
                    publicKeyHex: uint8ArrayToHex(identity.publicKey as Uint8Array),
                }
            } catch (error: any) {
                log.error("[manageNodeCall] crypto.getIdentity error: " + error)
                response.result = 500
                response.response = {
                    error: "NOT_READY",
                    message: "Crypto identity not ready",
                    details: error.message || String(error),
                }
            }
            break
        }

        // REVIEW: Token system - basic read APIs (perf harness support)
        case "token.get": {
            if (!data?.tokenAddress) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "tokenAddress is required",
                }
                break
            }

            try {
                const gcrTokenRepository = dataSource.getRepository(GCRToken)
                const token = await gcrTokenRepository.findOneBy({
                    address: data.tokenAddress,
                })

                if (!token) {
                    response.result = 404
                    response.response = {
                        error: "TOKEN_NOT_FOUND",
                        message: `Token not found: ${data.tokenAddress}`,
                    }
                    break
                }

                response.result = 200
                response.response = {
                    tokenAddress: token.address,
                    metadata: {
                        name: token.name,
                        ticker: token.ticker,
                        decimals: token.decimals,
                        deployer: token.deployer,
                        deployerNonce: token.deployerNonce,
                        deployedAt: token.deployedAt,
                        hasScript: token.hasScript,
                    },
                    state: {
                        totalSupply: token.totalSupply,
                        balances: token.balances ?? {},
                        allowances: token.allowances ?? {},
                        customState: token.customState ?? {},
                    },
                    accessControl: {
                        owner: token.owner,
                        paused: token.paused,
                        entries: token.aclEntries ?? [],
                    },
                }
            } catch (error: any) {
                log.error("[manageNodeCall] token.get error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to fetch token",
                    details: error.message || String(error),
                }
            }
            break
        }

        case "token.getBalance": {
            if (!data?.tokenAddress || !data?.address) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "tokenAddress and address are required",
                }
                break
            }

            try {
                const gcrTokenRepository = dataSource.getRepository(GCRToken)
                const token = await gcrTokenRepository.findOneBy({
                    address: data.tokenAddress,
                })

                if (!token) {
                    response.result = 404
                    response.response = {
                        error: "TOKEN_NOT_FOUND",
                        message: `Token not found: ${data.tokenAddress}`,
                    }
                    break
                }

                const balances: Record<string, string> = token.balances || {}
                const balance = balances[data.address] ?? "0"

                response.result = 200
                response.response = {
                    tokenAddress: data.tokenAddress,
                    address: data.address,
                    balance,
                }
            } catch (error: any) {
                log.error("[manageNodeCall] token.getBalance error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to fetch token balance",
                    details: error.message || String(error),
                }
            }
            break
        }

        // REVIEW: Token system - holder pointer lookups (GCRMain.extended.tokens)
        case "token.getHolderPointers": {
            if (!data?.address) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "address is required",
                }
                break
            }

            try {
                const gcrMainRepository = dataSource.getRepository(GCRMain)
                const holder = await gcrMainRepository.findOneBy({
                    pubkey: data.address,
                })

                if (!holder) {
                    response.result = 404
                    response.response = {
                        error: "HOLDER_NOT_FOUND",
                        message: `Holder not found: ${data.address}`,
                    }
                    break
                }

                response.result = 200
                response.response = {
                    address: holder.pubkey,
                    tokens: holder.extended?.tokens ?? [],
                }
            } catch (error: any) {
                log.error("[manageNodeCall] token.getHolderPointers error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to fetch holder pointers",
                    details: error.message || String(error),
                }
            }
            break
        }

        // REVIEW: Token scripting - Phase 3.3: View function execution
        case "token.callView": {
            log.debug("[SERVER] Received token.callView")

            // Validate required fields
            if (!data.tokenAddress || !data.method) {
                response.result = 400
                response.response = {
                    error: "INVALID_REQUEST",
                    message: "tokenAddress and method are required",
                }
                break
            }

            try {
                // Get token from repository
                const gcrTokenRepository = dataSource.getRepository(GCRToken)
                const token = await gcrTokenRepository.findOneBy({
                    address: data.tokenAddress,
                })

                if (!token) {
                    response.result = 404
                    response.response = {
                        error: "TOKEN_NOT_FOUND",
                        message: `Token not found: ${data.tokenAddress}`,
                    }
                    break
                }

                if (!token.hasScript) {
                    response.result = 400
                    response.response = {
                        error: "NO_SCRIPT",
                        message: "Token does not have a script",
                    }
                    break
                }

                // Build tokenData from GCRToken entity for ScriptExecutor
                // Type annotations needed for BigInt conversion from string values
                const balances: Record<string, string> = token.balances || {}
                const allowances: Record<string, Record<string, string>> =
                    token.allowances || {}

                const tokenData = {
                    address: token.address,
                    name: token.name,
                    ticker: token.ticker,
                    decimals: token.decimals,
                    owner: token.owner,
                    totalSupply: BigInt(token.totalSupply),
                    balances: Object.fromEntries(
                        Object.entries(balances).map(([k, v]) => [k, BigInt(v)]),
                    ),
                    allowances: Object.fromEntries(
                        Object.entries(allowances).map(([owner, spenders]) => [
                            owner,
                            Object.fromEntries(
                                Object.entries(spenders).map(([spender, v]) => [
                                    spender,
                                    BigInt(v),
                                ]),
                            ),
                        ]),
                    ),
                    paused: token.paused,
                    storage: token.customState,
                }

                // Execute view method via ScriptExecutor
                const viewResult = await scriptExecutor.executeView({
                    tokenAddress: data.tokenAddress,
                    method: data.method,
                    args: data.args ?? [],
                    tokenData,
                })

                if (!viewResult.success) {
                    // Type narrowing for error result
                    const errorResult = viewResult as Extract<
                        typeof viewResult,
                        { success: false }
                    >
                    response.result = 400
                    response.response = {
                        error: errorResult.errorType?.toUpperCase() ?? "EXECUTION_ERROR",
                        message: errorResult.error,
                        gasUsed: errorResult.gasUsed,
                        executionTimeMs: errorResult.executionTimeMs,
                    }
                    break
                }

                // Success response
                response.result = 200
                response.response = {
                    tokenAddress: data.tokenAddress,
                    method: data.method,
                    value: viewResult.value,
                    executionTimeMs: viewResult.executionTimeMs,
                    gasUsed: viewResult.gasUsed,
                }
            } catch (error: any) {
                log.error("[manageNodeCall] token.callView error: " + error)
                response.result = 500
                response.response = {
                    error: "INTERNAL_ERROR",
                    message: "Failed to execute view function",
                    details: error.message || String(error),
                }
            }
            break
        }

        default:
            log.warning("[SERVER] Received unknown message")
            // eslint-disable-next-line quotes
            response.response = '{ error: "Unknown message"}'
            break
    }

    // REVIEW Is this ok? Follow back and see
    return response
}
