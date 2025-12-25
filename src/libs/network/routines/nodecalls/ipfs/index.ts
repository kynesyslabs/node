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

export {
    getIpfsManager,
    ensureIpfsManager,
    shutdownIpfsManager,
} from "./ipfsManager"
