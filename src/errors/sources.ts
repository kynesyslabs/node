/**
 * Error source identifiers — where the error originated.
 *
 * Used in handleError() context to identify the subsystem/component
 * that produced the error for easier debugging and log filtering.
 */

export const ErrorSource = {
    // --- Core / Bootstrap ---
    UNCAUGHT_EXCEPTION: "uncaughtException",
    UNHANDLED_REJECTION: "unhandledRejection",
    MAIN: "main",
    TUI_STARTUP: "TUI startup",
    GRACEFUL_SHUTDOWN: "graceful shutdown",

    // --- L2PS ---
    L2PS_NETWORK_LOADING: "L2PS network loading",
    L2PS_SERVICES_STARTUP: "L2PS services startup",
    L2PS_SHUTDOWN: "L2PS shutdown",
    L2PS_BATCH: "L2PS batch",
    L2PS_PROOF: "L2PS proof",
    L2PS_SYNC: "L2PS sync",

    // --- Network / RPC ---
    RPC_SERVER: "serverRpcBun",
    SIGNALING_SERVER: "signaling server",
    DTR_RELAY: "DTR relay",

    // --- OmniProtocol ---
    OMNI_STARTUP: "OmniProtocol startup",
    OMNI_SHUTDOWN: "OmniProtocol shutdown",
    OMNI_PEER_ADAPTER: "OmniProtocol PeerAdapter.adaptCall",
    OMNI_INBOUND_DATA: "OmniProtocol InboundConnection.handleIncomingData",
    OMNI_INBOUND_MSG: "OmniProtocol InboundConnection.handleMessage",
    OMNI_MESSAGE_FRAMER: "OmniProtocol MessageFramer.extractMessage",
    OMNI_PEER_CONNECTION: "OmniProtocol PeerConnection.handleIncomingData",

    // --- Blockchain ---
    CHAIN_TX_INSERTION: "transaction insertion",
    CHAIN_SYNC_INSERTION: "ChainDB sync insertion",
    SYNC: "sync",
    SYNC_BLOCK_DOWNLOAD: "block download",
    SYNC_GCR_TABLE: "GCR table sync",

    // --- ZK / Merkle ---
    MERKLE_INIT: "MerkleTreeManager.initialize",
    MERKLE_ADD_COMMITMENT: "MerkleTreeManager.addCommitment",
    MERKLE_GENERATE_PROOF: "MerkleTreeManager.generateProof",
    MERKLE_GET_PROOF: "MerkleTreeManager.getProofForCommitment",
    MERKLE_SAVE: "MerkleTreeManager.saveToDatabase",
    MERKLE_VERIFY: "MerkleTreeManager.verifyProof",
    PROOF_LOAD_VKEY: "ProofVerifier.loadVerificationKey",
    PROOF_VERIFY_CRYPTO: "ProofVerifier.verifyCryptographically",
    PROOF_GROTH16: "groth16VerifyBun",

    // --- Services ---
    MCP_SHUTDOWN: "MCP shutdown",
    TLSN_SHUTDOWN: "TLSNotary shutdown",
    METRICS_SHUTDOWN: "Metrics shutdown",
    RPC_SHUTDOWN: "RPC shutdown",
    SIGNALING_SHUTDOWN: "Signaling shutdown",
    WORKER_POOL_STARTUP: "TxValidatorPool startup",
    WORKER_POOL_SHUTDOWN: "TxValidatorPool shutdown",

    // --- Identity ---
    IDENTITY_VERIFICATION: "identity verification",

    // --- Node Calls ---
    GET_TXS_BY_HASHES: "getTxsByHashes",
    MAIN_LOOP: "MAINLOOP",
} as const

export type ErrorSource = (typeof ErrorSource)[keyof typeof ErrorSource]
