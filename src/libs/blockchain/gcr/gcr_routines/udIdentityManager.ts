import ensureGCRForUser from "./ensureGCRForUser"
import log from "@/utilities/logger"
import { UDIdentityAssignPayload } from "@kynesyslabs/demosdk/abstraction"
import { ethers } from "ethers"

/**
 * UDIdentityManager - Handles Unstoppable Domains identity verification and storage
 *
 * Verification Flow:
 * 1. User provides UD domain (e.g., "alice.crypto")
 * 2. Resolve domain to get owner's Ethereum address from UNS/CNS registry
 * 3. Verify signature was created by the resolved address
 * 4. Store UD identity in GCR database
 *
 * Pattern: Follows XM signature-based verification (not web2 URL-based)
 */

// REVIEW: UD Registry contracts on Ethereum Mainnet
const unsRegistryAddress = "0x049aba7510f45BA5b64ea9E658E342F904DB358D" // Newer standard
const cnsRegistryAddress = "0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe" // Legacy

const registryAbi = [
    "function ownerOf(uint256 tokenId) external view returns (address)",
]

export class UDIdentityManager {
    constructor() {}

    /**
     * Resolve an Unstoppable Domain to its owner's Ethereum address
     *
     * @param domain - The UD domain (e.g., "brad.crypto")
     * @returns Object with owner address and registry type (UNS or CNS)
     */
    private static async resolveUDDomain(
        domain: string,
    ): Promise<{ owner: string; registryType: "UNS" | "CNS" }> {
        try {
            // REVIEW: Using public Ethereum RPC endpoint
            // For production, consider using Demos node's own RPC or dedicated provider
            const provider = new ethers.JsonRpcProvider(
                "https://eth.llamarpc.com",
            )

            // Convert domain to tokenId using namehash algorithm
            const tokenId = ethers.namehash(domain)

            // Try UNS Registry first (newer standard)
            try {
                const unsRegistry = new ethers.Contract(
                    unsRegistryAddress,
                    registryAbi,
                    provider,
                )

                const owner = await unsRegistry.ownerOf(tokenId)
                log.debug(`Domain ${domain} owner (UNS): ${owner}`)
                return { owner, registryType: "UNS" }
            } catch (unsError) {
                // If UNS fails, try CNS Registry (legacy)
                const cnsRegistry = new ethers.Contract(
                    cnsRegistryAddress,
                    registryAbi,
                    provider,
                )

                const owner = await cnsRegistry.ownerOf(tokenId)
                log.debug(`Domain ${domain} owner (CNS): ${owner}`)
                return { owner, registryType: "CNS" }
            }
        } catch (error) {
            log.error(`Error resolving UD domain ${domain}: ${error}`)
            throw new Error(`Failed to resolve domain ${domain}: ${error}`)
        }
    }

    /**
     * Verify UD domain ownership and signature
     *
     * @param payload - The UD identity payload from transaction
     * @param sender - The ed25519 address from transaction body
     * @returns Verification result with success status and message
     */
    static async verifyPayload(
        payload: UDIdentityAssignPayload,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const { domain, resolvedAddress, signature, signedData } =
                payload.payload

            // Step 1: Resolve domain to get actual owner address
            const { owner: actualOwner, registryType } =
                await this.resolveUDDomain(domain)

            log.debug(
                `Verifying UD domain ${domain}: resolved=${resolvedAddress}, actual=${actualOwner}`,
            )

            // Step 2: Verify resolved address matches actual owner
            if (actualOwner.toLowerCase() !== resolvedAddress.toLowerCase()) {
                return {
                    success: false,
                    message: `Domain ownership mismatch: domain ${domain} is owned by ${actualOwner}, not ${resolvedAddress}`,
                }
            }

            // Step 3: Verify signature from resolved address
            // ethers.verifyMessage recovers the address that signed the message
            let recoveredAddress: string
            try {
                recoveredAddress = ethers.verifyMessage(signedData, signature)
            } catch (error) {
                log.error(`Error verifying signature: ${error}`)
                return {
                    success: false,
                    message: `Invalid signature format: ${error}`,
                }
            }

            log.debug(`Recovered address from signature: ${recoveredAddress}`)

            // Step 4: Verify recovered address matches resolved address
            if (
                recoveredAddress.toLowerCase() !== resolvedAddress.toLowerCase()
            ) {
                return {
                    success: false,
                    message: `Signature verification failed: signed by ${recoveredAddress}, expected ${resolvedAddress}`,
                }
            }

            // Step 5: Verify challenge contains correct Demos public key
            if (!signedData.includes(sender)) {
                return {
                    success: false,
                    message:
                        "Challenge message does not contain Demos public key",
                }
            }

            log.info(
                `UD identity verified for domain ${domain} (${registryType} registry)`,
            )

            return {
                success: true,
                message: `Verified ownership of ${domain} via ${registryType} registry`,
            }
        } catch (error) {
            log.error(`Error verifying UD payload: ${error}`)
            return {
                success: false,
                message: `Verification error: ${error}`,
            }
        }
    }

    /**
     * Get UD identities for a Demos address
     *
     * @param address - The Demos address
     * @returns Array of saved UD identities
     */
    static async getUdIdentities(address: string): Promise<any[]> {
        const gcr = await ensureGCRForUser(address)
        // REVIEW: Defensive initialization for backward compatibility
        return gcr.identities.ud || []
    }

    /**
     * Get all identities for a Demos address
     *
     * @param address - The Demos address
     * @param key - Optional key to get specific identity type
     * @returns Identities object or specific identity type
     */
    static async getIdentities(address: string, key?: string): Promise<any> {
        const gcr = await ensureGCRForUser(address)
        if (key) {
            return gcr.identities[key]
        }

        return gcr.identities
    }
}
