/**
 * StorageProgram Feature Module
 *
 * Provides unified storage capabilities for JSON and binary data on the Demos Network.
 * Supports robust ACL (owner, public, restricted modes with groups and blacklists).
 *
 * Features:
 * - JSON storage with 64-level nesting support
 * - Binary storage with base64 encoding
 * - Max 1MB data, priced at 1 DEM per 10KB
 * - Robust ACL with owner, allowed, blacklisted, and group-based permissions
 * - IPFS-ready with storageLocation and ipfsCid fields (stubs for future)
 *
 * @module features/storageprogram
 */

// REVIEW: StorageProgram feature module - entry point for unified storage feature

import type { BunServer } from "@/libs/network/bunServer"
import { registerStorageProgramRoutes } from "./routes"
import log from "@/utilities/logger"

// Re-export routes for direct access if needed
export { registerStorageProgramRoutes } from "./routes"

/**
 * Initialize StorageProgram feature
 *
 * Registers HTTP routes with BunServer for storage program access.
 *
 * @param server - BunServer instance for route registration
 */
export function initializeStorageProgram(server: BunServer): void {
    registerStorageProgramRoutes(server)
    log.info("[StorageProgram] Feature initialized")
}
