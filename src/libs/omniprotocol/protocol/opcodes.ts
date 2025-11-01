export enum OmniOpcode {
    // 0x0X Control & Infrastructure
    PING = 0x00,
    HELLO_PEER = 0x01,
    AUTH = 0x02,
    NODE_CALL = 0x03,
    GET_PEERLIST = 0x04,
    GET_PEER_INFO = 0x05,
    GET_NODE_VERSION = 0x06,
    GET_NODE_STATUS = 0x07,

    // 0x1X Transactions & Execution
    EXECUTE = 0x10,
    NATIVE_BRIDGE = 0x11,
    BRIDGE = 0x12,
    BRIDGE_GET_TRADE = 0x13,
    BRIDGE_EXECUTE_TRADE = 0x14,
    CONFIRM = 0x15,
    BROADCAST = 0x16,

    // 0x2X Data Synchronization
    MEMPOOL_SYNC = 0x20,
    MEMPOOL_MERGE = 0x21,
    PEERLIST_SYNC = 0x22,
    BLOCK_SYNC = 0x23,
    GET_BLOCKS = 0x24,
    GET_BLOCK_BY_NUMBER = 0x25,
    GET_BLOCK_BY_HASH = 0x26,
    GET_TX_BY_HASH = 0x27,
    GET_MEMPOOL = 0x28,

    // 0x3X Consensus
    CONSENSUS_GENERIC = 0x30,
    PROPOSE_BLOCK_HASH = 0x31,
    VOTE_BLOCK_HASH = 0x32,
    BROADCAST_BLOCK = 0x33,
    GET_COMMON_VALIDATOR_SEED = 0x34,
    GET_VALIDATOR_TIMESTAMP = 0x35,
    SET_VALIDATOR_PHASE = 0x36,
    GET_VALIDATOR_PHASE = 0x37,
    GREENLIGHT = 0x38,
    GET_BLOCK_TIMESTAMP = 0x39,
    VALIDATOR_STATUS_SYNC = 0x3A,

    // 0x4X GCR Operations
    GCR_GENERIC = 0x40,
    GCR_IDENTITY_ASSIGN = 0x41,
    GCR_GET_IDENTITIES = 0x42,
    GCR_GET_WEB2_IDENTITIES = 0x43,
    GCR_GET_XM_IDENTITIES = 0x44,
    GCR_GET_POINTS = 0x45,
    GCR_GET_TOP_ACCOUNTS = 0x46,
    GCR_GET_REFERRAL_INFO = 0x47,
    GCR_VALIDATE_REFERRAL = 0x48,
    GCR_GET_ACCOUNT_BY_IDENTITY = 0x49,
    GCR_GET_ADDRESS_INFO = 0x4A,
    GCR_GET_ADDRESS_NONCE = 0x4B,

    // 0x5X Browser / Client
    LOGIN_REQUEST = 0x50,
    LOGIN_RESPONSE = 0x51,
    WEB2_PROXY_REQUEST = 0x52,
    GET_TWEET = 0x53,
    GET_DISCORD_MESSAGE = 0x54,

    // 0x6X Admin Operations
    ADMIN_RATE_LIMIT_UNBLOCK = 0x60,
    ADMIN_GET_CAMPAIGN_DATA = 0x61,
    ADMIN_AWARD_POINTS = 0x62,

    // 0xFX Protocol Meta
    PROTO_VERSION_NEGOTIATE = 0xF0,
    PROTO_CAPABILITY_EXCHANGE = 0xF1,
    PROTO_ERROR = 0xF2,
    PROTO_PING = 0xF3,
    PROTO_DISCONNECT = 0xF4
}

export const ALL_REGISTERED_OPCODES: OmniOpcode[] = Object.values(OmniOpcode).filter(
    (value) => typeof value === "number",
) as OmniOpcode[]

export function opcodeToString(opcode: OmniOpcode): string {
    return OmniOpcode[opcode] ?? `UNKNOWN_${opcode}`
}

