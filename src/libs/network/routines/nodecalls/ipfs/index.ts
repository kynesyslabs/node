/**
 * IPFS NodeCall Handlers Index
 *
 * Exports all IPFS-related RPC handlers for integration with manageNodeCall.
 *
 * @fileoverview IPFS nodecalls index
 */

export { default as ipfsStatus } from "./ipfsStatus"
export { default as ipfsAdd } from "./ipfsAdd"
export { default as ipfsGet } from "./ipfsGet"
export { default as ipfsPin } from "./ipfsPin"
export { default as ipfsUnpin } from "./ipfsUnpin"
export { default as ipfsListPins } from "./ipfsListPins"
// REVIEW: Account-based pins query (Phase 3)
export { default as ipfsPins } from "./ipfsPins"
// REVIEW: Streaming endpoints for large files (Phase 8)
export { default as ipfsAddStream } from "./ipfsAddStream"
export { default as ipfsGetStream } from "./ipfsGetStream"
// REVIEW: Swarm management endpoints (Phase 4)
export { default as ipfsSwarmPeers } from "./ipfsSwarmPeers"
export { default as ipfsSwarmConnect } from "./ipfsSwarmConnect"
export { default as ipfsSwarmDisconnect } from "./ipfsSwarmDisconnect"
export { default as ipfsBootstrapList } from "./ipfsBootstrapList"
export { default as ipfsClusterPin } from "./ipfsClusterPin"
export { default as ipfsDemosPeers } from "./ipfsDemosPeers"
// REVIEW: Public Bridge endpoints (Phase 5)
export { default as ipfsPublicFetch } from "./ipfsPublicFetch"
export { default as ipfsPublicPublish } from "./ipfsPublicPublish"
export { default as ipfsPublicCheck } from "./ipfsPublicCheck"
export { default as ipfsRateLimitStatus } from "./ipfsRateLimitStatus"
// REVIEW: Phase 9 - Cost estimation endpoint
export { default as ipfsQuote } from "./ipfsQuote"

export {
    getIpfsManager,
    ensureIpfsManager,
    shutdownIpfsManager,
} from "./ipfsManager"
