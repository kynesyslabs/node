/**
 * IPFS Manager Singleton Access
 *
 * Provides lazy initialization and singleton access to the IPFS manager.
 * The manager is initialized on first use and reused thereafter.
 *
 * @fileoverview IPFS manager singleton
 */

import { IPFSManager, createIpfsManager } from "@/features/ipfs"
import log from "@/utilities/logger"

let ipfsManager: IPFSManager | null = null
let initializationPromise: Promise<void> | null = null

/**
 * Get the IPFS manager instance
 *
 * Returns the initialized IPFS manager or null if not yet initialized.
 * Use ensureIpfsManager() for auto-initialization.
 */
export function getIpfsManager(): IPFSManager | null {
    return ipfsManager
}

/**
 * Ensure IPFS manager is initialized and return it
 *
 * Thread-safe initialization that handles concurrent calls.
 *
 * @returns Initialized IPFS manager
 * @throws If initialization fails
 */
export async function ensureIpfsManager(): Promise<IPFSManager> {
    if (ipfsManager?.isInitialized()) {
        return ipfsManager
    }

    // Avoid double initialization
    if (initializationPromise) {
        await initializationPromise
        return ipfsManager!
    }

    initializationPromise = (async () => {
        log.debug("[IPFS] Initializing IPFS manager...")

        ipfsManager = createIpfsManager({
            debug: process.env.NODE_ENV !== "production",
        })

        try {
            await ipfsManager.initialize()
            log.info("[IPFS] IPFS manager initialized successfully")
        } catch (error) {
            log.error(`[IPFS] Failed to initialize IPFS manager: ${error}`)
            ipfsManager = null
            throw error
        }
    })()

    await initializationPromise
    return ipfsManager!
}

/**
 * Shutdown the IPFS manager
 *
 * Clears the cached instance. Should be called during node shutdown.
 */
export async function shutdownIpfsManager(): Promise<void> {
    if (ipfsManager) {
        await ipfsManager.shutdown()
        ipfsManager = null
        initializationPromise = null
        log.debug("[IPFS] IPFS manager shut down")
    }
}
