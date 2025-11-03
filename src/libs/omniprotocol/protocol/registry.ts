/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { OmniHandler } from "../types/message"
import { OmniOpcode, opcodeToString } from "./opcodes"
import {
    handleGetPeerlist,
    handleGetNodeStatus,
    handleGetNodeVersion,
    handleGetPeerInfo,
    handleNodeCall,
    handlePeerlistSync,
} from "./handlers/control"
import {
    handleBlockSync,
    handleGetBlockByHash,
    handleGetBlockByNumber,
    handleGetBlocks,
    handleGetMempool,
    handleGetTxByHash,
    handleMempoolMerge,
    handleMempoolSync,
} from "./handlers/sync"
import {
    handleGetAddressInfo,
    handleGetIdentities,
    handleGetWeb2Identities,
    handleGetXmIdentities,
    handleGetPoints,
    handleGetTopAccounts,
    handleGetReferralInfo,
    handleValidateReferral,
    handleGetAccountByIdentity,
    handleIdentityAssign,
} from "./handlers/gcr"
import {
    handleExecute,
    handleNativeBridge,
    handleBridge,
    handleBroadcast,
    handleConfirm,
} from "./handlers/transaction"
import {
    handleProtoCapabilityExchange,
    handleProtoDisconnect,
    handleProtoError,
    handleProtoPing,
    handleProtoVersionNegotiate,
} from "./handlers/meta"
import {
    handleProposeBlockHash,
    handleSetValidatorPhase,
    handleGreenlight,
    handleGetCommonValidatorSeed,
    handleGetValidatorTimestamp,
    handleGetValidatorPhase,
    handleGetBlockTimestamp,
} from "./handlers/consensus"

export interface HandlerDescriptor {
    opcode: OmniOpcode
    name: string
    authRequired: boolean
    handler: OmniHandler
}

export type HandlerRegistry = Map<OmniOpcode, HandlerDescriptor>

const createHttpFallbackHandler = (): OmniHandler => {
    return async ({ fallbackToHttp }) => fallbackToHttp()
}

const DESCRIPTORS: HandlerDescriptor[] = [
    // 0x0X Control & Infrastructure
    { opcode: OmniOpcode.PING, name: "ping", authRequired: false, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.HELLO_PEER, name: "hello_peer", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.AUTH, name: "auth", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.NODE_CALL, name: "nodeCall", authRequired: false, handler: handleNodeCall },
    { opcode: OmniOpcode.GET_PEERLIST, name: "getPeerlist", authRequired: false, handler: handleGetPeerlist },
    { opcode: OmniOpcode.GET_PEER_INFO, name: "getPeerInfo", authRequired: false, handler: handleGetPeerInfo },
    { opcode: OmniOpcode.GET_NODE_VERSION, name: "getNodeVersion", authRequired: false, handler: handleGetNodeVersion },
    { opcode: OmniOpcode.GET_NODE_STATUS, name: "getNodeStatus", authRequired: false, handler: handleGetNodeStatus },

    // 0x1X Transactions & Execution
    { opcode: OmniOpcode.EXECUTE, name: "execute", authRequired: true, handler: handleExecute },
    { opcode: OmniOpcode.NATIVE_BRIDGE, name: "nativeBridge", authRequired: true, handler: handleNativeBridge },
    { opcode: OmniOpcode.BRIDGE, name: "bridge", authRequired: true, handler: handleBridge },
    { opcode: OmniOpcode.BRIDGE_GET_TRADE, name: "bridge_getTrade", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.BRIDGE_EXECUTE_TRADE, name: "bridge_executeTrade", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.CONFIRM, name: "confirm", authRequired: true, handler: handleConfirm },
    { opcode: OmniOpcode.BROADCAST, name: "broadcast", authRequired: true, handler: handleBroadcast },

    // 0x2X Data Synchronization
    { opcode: OmniOpcode.MEMPOOL_SYNC, name: "mempool_sync", authRequired: true, handler: handleMempoolSync },
    { opcode: OmniOpcode.MEMPOOL_MERGE, name: "mempool_merge", authRequired: true, handler: handleMempoolMerge },
    { opcode: OmniOpcode.PEERLIST_SYNC, name: "peerlist_sync", authRequired: true, handler: handlePeerlistSync },
    { opcode: OmniOpcode.BLOCK_SYNC, name: "block_sync", authRequired: true, handler: handleBlockSync },
    { opcode: OmniOpcode.GET_BLOCKS, name: "getBlocks", authRequired: false, handler: handleGetBlocks },
    { opcode: OmniOpcode.GET_BLOCK_BY_NUMBER, name: "getBlockByNumber", authRequired: false, handler: handleGetBlockByNumber },
    { opcode: OmniOpcode.GET_BLOCK_BY_HASH, name: "getBlockByHash", authRequired: false, handler: handleGetBlockByHash },
    { opcode: OmniOpcode.GET_TX_BY_HASH, name: "getTxByHash", authRequired: false, handler: handleGetTxByHash },
    { opcode: OmniOpcode.GET_MEMPOOL, name: "getMempool", authRequired: false, handler: handleGetMempool },

    // 0x3X Consensus
    { opcode: OmniOpcode.CONSENSUS_GENERIC, name: "consensus_generic", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.PROPOSE_BLOCK_HASH, name: "proposeBlockHash", authRequired: true, handler: handleProposeBlockHash },
    { opcode: OmniOpcode.VOTE_BLOCK_HASH, name: "voteBlockHash", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.BROADCAST_BLOCK, name: "broadcastBlock", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.GET_COMMON_VALIDATOR_SEED, name: "getCommonValidatorSeed", authRequired: true, handler: handleGetCommonValidatorSeed },
    { opcode: OmniOpcode.GET_VALIDATOR_TIMESTAMP, name: "getValidatorTimestamp", authRequired: true, handler: handleGetValidatorTimestamp },
    { opcode: OmniOpcode.SET_VALIDATOR_PHASE, name: "setValidatorPhase", authRequired: true, handler: handleSetValidatorPhase },
    { opcode: OmniOpcode.GET_VALIDATOR_PHASE, name: "getValidatorPhase", authRequired: true, handler: handleGetValidatorPhase },
    { opcode: OmniOpcode.GREENLIGHT, name: "greenlight", authRequired: true, handler: handleGreenlight },
    { opcode: OmniOpcode.GET_BLOCK_TIMESTAMP, name: "getBlockTimestamp", authRequired: true, handler: handleGetBlockTimestamp },
    { opcode: OmniOpcode.VALIDATOR_STATUS_SYNC, name: "validatorStatusSync", authRequired: true, handler: createHttpFallbackHandler() },

    // 0x4X GCR Operations
    { opcode: OmniOpcode.GCR_GENERIC, name: "gcr_generic", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.GCR_IDENTITY_ASSIGN, name: "gcr_identityAssign", authRequired: true, handler: handleIdentityAssign },
    { opcode: OmniOpcode.GCR_GET_IDENTITIES, name: "gcr_getIdentities", authRequired: false, handler: handleGetIdentities },
    { opcode: OmniOpcode.GCR_GET_WEB2_IDENTITIES, name: "gcr_getWeb2Identities", authRequired: false, handler: handleGetWeb2Identities },
    { opcode: OmniOpcode.GCR_GET_XM_IDENTITIES, name: "gcr_getXmIdentities", authRequired: false, handler: handleGetXmIdentities },
    { opcode: OmniOpcode.GCR_GET_POINTS, name: "gcr_getPoints", authRequired: false, handler: handleGetPoints },
    { opcode: OmniOpcode.GCR_GET_TOP_ACCOUNTS, name: "gcr_getTopAccounts", authRequired: false, handler: handleGetTopAccounts },
    { opcode: OmniOpcode.GCR_GET_REFERRAL_INFO, name: "gcr_getReferralInfo", authRequired: false, handler: handleGetReferralInfo },
    { opcode: OmniOpcode.GCR_VALIDATE_REFERRAL, name: "gcr_validateReferral", authRequired: true, handler: handleValidateReferral },
    { opcode: OmniOpcode.GCR_GET_ACCOUNT_BY_IDENTITY, name: "gcr_getAccountByIdentity", authRequired: false, handler: handleGetAccountByIdentity },
    { opcode: OmniOpcode.GCR_GET_ADDRESS_INFO, name: "gcr_getAddressInfo", authRequired: false, handler: handleGetAddressInfo },
    { opcode: OmniOpcode.GCR_GET_ADDRESS_NONCE, name: "gcr_getAddressNonce", authRequired: false, handler: createHttpFallbackHandler() },

    // 0x5X Browser / Client
    { opcode: OmniOpcode.LOGIN_REQUEST, name: "login_request", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.LOGIN_RESPONSE, name: "login_response", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.WEB2_PROXY_REQUEST, name: "web2ProxyRequest", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.GET_TWEET, name: "getTweet", authRequired: false, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.GET_DISCORD_MESSAGE, name: "getDiscordMessage", authRequired: false, handler: createHttpFallbackHandler() },

    // 0x6X Admin
    { opcode: OmniOpcode.ADMIN_RATE_LIMIT_UNBLOCK, name: "admin_rateLimitUnblock", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.ADMIN_GET_CAMPAIGN_DATA, name: "admin_getCampaignData", authRequired: true, handler: createHttpFallbackHandler() },
    { opcode: OmniOpcode.ADMIN_AWARD_POINTS, name: "admin_awardPoints", authRequired: true, handler: createHttpFallbackHandler() },

    // 0xFX Meta
    { opcode: OmniOpcode.PROTO_VERSION_NEGOTIATE, name: "proto_versionNegotiate", authRequired: false, handler: handleProtoVersionNegotiate },
    { opcode: OmniOpcode.PROTO_CAPABILITY_EXCHANGE, name: "proto_capabilityExchange", authRequired: false, handler: handleProtoCapabilityExchange },
    { opcode: OmniOpcode.PROTO_ERROR, name: "proto_error", authRequired: false, handler: handleProtoError },
    { opcode: OmniOpcode.PROTO_PING, name: "proto_ping", authRequired: false, handler: handleProtoPing },
    { opcode: OmniOpcode.PROTO_DISCONNECT, name: "proto_disconnect", authRequired: false, handler: handleProtoDisconnect },
]

export const handlerRegistry: HandlerRegistry = new Map()

for (const descriptor of DESCRIPTORS) {
    if (handlerRegistry.has(descriptor.opcode)) {
        const existing = handlerRegistry.get(descriptor.opcode)!
        throw new Error(
            `Duplicate handler registration for opcode ${opcodeToString(descriptor.opcode)} (existing: ${existing.name}, new: ${descriptor.name})`,
        )
    }

    handlerRegistry.set(descriptor.opcode, descriptor)
}

export function getHandler(opcode: OmniOpcode): HandlerDescriptor | undefined {
    return handlerRegistry.get(opcode)
}
