import ensureGCRForUser from "./ensureGCRForUser"
import log from "@/utilities/logger"
import { UDIdentityAssignPayload } from "node_modules/@kynesyslabs/demosdk/build/types/abstraction"
import { ethers } from "ethers"
import { SavedUdIdentity } from "@/model/entities/types/IdentityTypes"

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

// REVIEW: UD Registry contracts - Multi-chain support
// Polygon L2 (primary - most new domains, cheaper gas)
const polygonUnsRegistryAddress = "0xa9a6A3626993D487d2Dbda3173cf58cA1a9D9e9f"
// Base L2 UNS (new L2 option - growing adoption)
const baseUnsRegistryAddress = "0xF6c1b83977DE3dEffC476f5048A0a84d3375d498"
// Sonic UNS (emerging network support)
const sonicUnsRegistryAddress = "0xDe1DAdcF11a7447C3D093e97FdbD513f488cE3b4"
// Ethereum L1 UNS (fallback for legacy domains)
const ethereumUnsRegistryAddress = "0x049aba7510f45BA5b64ea9E658E342F904DB358D"
// Ethereum L1 CNS (oldest legacy domains)
const ethereumCnsRegistryAddress = "0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe"

const registryAbi = [
    "function ownerOf(uint256 tokenId) external view returns (address)",
]

export class UDIdentityManager {
    constructor() {}

    /**
     * Resolve an Unstoppable Domain to its owner's Ethereum address
     *
     * Multi-chain resolution strategy (per UD docs):
     * 1. Try Polygon L2 UNS first (most new domains, cheaper gas)
     * 2. Try Base L2 UNS (new L2 option - growing adoption)
     * 3. Try Sonic (emerging network support)
     * 4. Fallback to Ethereum L1 UNS (legacy domains)
     * 5. Fallback to Ethereum L1 CNS (oldest legacy domains)
     *
     * @param domain - The UD domain (e.g., "brad.crypto")
     * @returns Object with owner address, network, and registry type
     */
    private static async resolveUDDomain(
        domain: string,
    ): Promise<{
        owner: string
        network: "polygon" | "ethereum" | "base" | "sonic"
        registryType: "UNS" | "CNS"
    }> {
        try {
            // Convert domain to tokenId using namehash algorithm
            const tokenId = ethers.namehash(domain)

            // Try Polygon L2 UNS first (primary - most new domains)
            try {
                const polygonProvider = new ethers.JsonRpcProvider(
                    "https://polygon-rpc.com",
                )
                const polygonUnsRegistry = new ethers.Contract(
                    polygonUnsRegistryAddress,
                    registryAbi,
                    polygonProvider,
                )

                const owner = await polygonUnsRegistry.ownerOf(tokenId)
                log.debug(`Domain ${domain} owner (Polygon UNS): ${owner}`)
                return { owner, network: "polygon", registryType: "UNS" }
            } catch (polygonError) {
                log.debug(
                    `Polygon UNS lookup failed for ${domain}, trying Base`,
                )

                // Try Base L2 UNS (new L2 option)
                try {
                    const baseProvider = new ethers.JsonRpcProvider(
                        "https://mainnet.base.org",
                    )
                    const baseUnsRegistry = new ethers.Contract(
                        baseUnsRegistryAddress,
                        registryAbi,
                        baseProvider,
                    )

                    const owner = await baseUnsRegistry.ownerOf(tokenId)
                    log.debug(`Domain ${domain} owner (Base UNS): ${owner}`)
                    return { owner, network: "base", registryType: "UNS" }
                } catch (baseError) {
                    log.debug(
                        `Base UNS lookup failed for ${domain}, trying Sonic`,
                    )

                    // Try Sonic (emerging network)
                    try {
                        const sonicProvider = new ethers.JsonRpcProvider(
                            "https://rpc.soniclabs.com",
                        )
                        const sonicUnsRegistry = new ethers.Contract(
                            sonicUnsRegistryAddress,
                            registryAbi,
                            sonicProvider,
                        )

                        const owner = await sonicUnsRegistry.ownerOf(tokenId)
                        log.debug(`Domain ${domain} owner (Sonic UNS): ${owner}`)
                        return { owner, network: "sonic", registryType: "UNS" }
                    } catch (sonicError) {
                        log.debug(
                            `Sonic UNS lookup failed for ${domain}, trying Ethereum`,
                        )

                        // Try Ethereum L1 UNS (fallback)
                        try {
                            const ethereumProvider = new ethers.JsonRpcProvider(
                                "https://eth.llamarpc.com",
                            )
                            const ethereumUnsRegistry = new ethers.Contract(
                                ethereumUnsRegistryAddress,
                                registryAbi,
                                ethereumProvider,
                            )

                            const owner = await ethereumUnsRegistry.ownerOf(tokenId)
                            log.debug(`Domain ${domain} owner (Ethereum UNS): ${owner}`)
                            return { owner, network: "ethereum", registryType: "UNS" }
                        } catch (ethereumUnsError) {
                            log.debug(
                                `Ethereum UNS lookup failed for ${domain}, trying CNS`,
                            )

                            // Try Ethereum L1 CNS (legacy fallback)
                            const ethereumProvider = new ethers.JsonRpcProvider(
                                "https://eth.llamarpc.com",
                            )
                            const ethereumCnsRegistry = new ethers.Contract(
                                ethereumCnsRegistryAddress,
                                registryAbi,
                                ethereumProvider,
                            )

                            const owner = await ethereumCnsRegistry.ownerOf(tokenId)
                            log.debug(`Domain ${domain} owner (Ethereum CNS): ${owner}`)
                            return { owner, network: "ethereum", registryType: "CNS" }
                        }
                    }
                }
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
            const { domain, resolvedAddress, signature, signedData, network, registryType } =
                payload.payload

            // Step 1: Resolve domain to get actual owner address and verify network
            const resolution = await this.resolveUDDomain(domain)

            log.debug(
                `Verifying UD domain ${domain}: resolved=${resolvedAddress}, actual=${resolution.owner}, network=${resolution.network}`,
            )

            // Step 2: Verify resolved address matches actual owner
            if (resolution.owner.toLowerCase() !== resolvedAddress.toLowerCase()) {
                return {
                    success: false,
                    message: `Domain ownership mismatch: domain ${domain} is owned by ${resolution.owner}, not ${resolvedAddress}`,
                }
            }

            // Step 2.5: Verify network matches (warn if mismatch but allow)
            if (resolution.network !== network) {
                log.warning(
                    `Network mismatch for ${domain}: claimed=${network}, actual=${resolution.network}`,
                )
            }

            // Step 2.6: Verify registry type matches (warn if mismatch but allow)
            if (resolution.registryType !== registryType) {
                log.warning(
                    `Registry type mismatch for ${domain}: claimed=${registryType}, actual=${resolution.registryType}`,
                )
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
                `UD identity verified for domain ${domain} (${resolution.network} ${resolution.registryType} registry)`,
            )

            return {
                success: true,
                message: `Verified ownership of ${domain} via ${resolution.network} ${resolution.registryType} registry`,
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
    static async getUdIdentities(address: string): Promise<SavedUdIdentity[]> {
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
