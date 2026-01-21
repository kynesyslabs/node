import { ethers, namehash, JsonRpcProvider, verifyMessage } from "ethers"

import log from "@/utilities/logger"
import IdentityManager from "./identityManager"
import ensureGCRForUser from "./ensureGCRForUser"
import { detectSignatureType } from "./signatureDetector"
import { SolanaDomainResolver } from "./udSolanaResolverHelper"
import { SavedUdIdentity } from "@/model/entities/types/IdentityTypes"

import {
    EVMDomainResolution,
    SignableAddress,
    UDIdentityAssignPayload,
    UnifiedDomainResolution,
} from "@kynesyslabs/demosdk/types"
import { SOLANA } from "@kynesyslabs/demosdk/xmcore"

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
    "function resolverOf(uint256 tokenId) external view returns (address)",
]

const resolverAbi = [
    "function get(string key, uint256 tokenId) external view returns (string)",
]

// REVIEW: UD record keys to fetch for multi-address verification
// Based on test data: EVM domains have sparse records, prioritize common ones
const UD_RECORD_KEYS = [
    "crypto.ETH.address",
    "crypto.SOL.address",
    "crypto.BTC.address",
    "crypto.MATIC.address",
    "token.EVM.ETH.ETH.address",
    "token.EVM.MATIC.MATIC.address",
    "token.SOL.SOL.SOL.address",
    "token.SOL.SOL.USDC.address",
]

export class UDIdentityManager {
    constructor() {}

    /**
     * Convert EVM domain resolution to unified format
     *
     * @param evmResolution - EVM resolution result
     * @returns UnifiedDomainResolution
     */
    private static evmToUnified(
        evmResolution: EVMDomainResolution,
        registryType: "UNS" | "CNS",
    ): UnifiedDomainResolution {
        const authorizedAddresses = this.extractSignableAddresses(
            evmResolution.records,
        )

        return {
            domain: evmResolution.domain,
            network: evmResolution.network,
            registryType, // Use parameter instead of hardcoded value
            authorizedAddresses,
            metadata: {
                evm: {
                    tokenId: evmResolution.tokenId,
                    owner: evmResolution.owner,
                    resolver: evmResolution.resolver,
                },
            },
        }
    }

    /**
     * Convert Solana domain resolution to unified format
     *
     * @param solanaResolution - Solana resolution result from SolanaDomainResolver
     * @returns UnifiedDomainResolution
     */
    private static solanaToUnified(
        solanaResolution: import("./udSolanaResolverHelper").DomainResolutionResult,
    ): UnifiedDomainResolution {
        // Convert Solana records to Record<string, string | null> format
        const recordsMap: Record<string, string | null> = {}
        for (const record of solanaResolution.records) {
            recordsMap[record.key] = record.value
        }

        const authorizedAddresses = this.extractSignableAddresses(recordsMap)

        return {
            domain: solanaResolution.domain,
            network: "solana",
            registryType: "UNS",
            authorizedAddresses,
            metadata: {
                solana: {
                    sldPda: solanaResolution.sldPda,
                    domainPropertiesPda:
                        solanaResolution.domainPropertiesPda || "",
                    recordsVersion: solanaResolution.recordsVersion || 0,
                    owner: solanaResolution.owner,
                },
            },
        }
    }

    /**
     * Fetch all domain records from a resolver contract
     *
     * @param resolver - ethers Contract instance for the resolver
     * @param tokenId - Domain token ID (namehash)
     * @returns Record key-value pairs
     */
    private static async fetchDomainRecords(
        resolver: ethers.Contract,
        tokenId: string,
    ): Promise<Record<string, string | null>> {
        const records: Record<string, string | null> = {}

        for (const key of UD_RECORD_KEYS) {
            try {
                const value = await resolver.get(key, tokenId)
                records[key] = value && value !== "" ? value : null
            } catch {
                records[key] = null
            }
        }

        return records
    }

    /**
     * Extract signable addresses from domain records
     *
     * @param records - Record key-value pairs from domain resolution
     * @returns Array of signable addresses with their metadata
     */
    private static extractSignableAddresses(
        records: Record<string, string | null>,
    ): SignableAddress[] {
        const signableAddresses: SignableAddress[] = []

        for (const [recordKey, address] of Object.entries(records)) {
            // Skip null/empty addresses
            if (!address || address === "") {
                continue
            }

            // Detect signature type from address format
            const signatureType = detectSignatureType(address)
            if (!signatureType) {
                log.debug(
                    `Skipping unrecognized address format: ${address} (${recordKey})`,
                )
                continue
            }

            signableAddresses.push({
                address,
                recordKey,
                signatureType,
            })
        }

        return signableAddresses
    }

    /**
     * Try resolving domain on a specific EVM network
     *
     * @param domain - The UD domain name
     * @param tokenId - The namehash tokenId
     * @param rpcUrl - RPC endpoint URL for the network
     * @param registryAddress - UNS/CNS registry contract address
     * @param networkName - Network name (polygon, base, sonic, ethereum)
     * @param registryType - Registry type (UNS or CNS)
     * @returns UnifiedDomainResolution on success, null on failure
     */
    private static async tryEvmNetwork(
        domain: string,
        tokenId: string,
        rpcUrl: string,
        registryAddress: string,
        networkName: "polygon" | "base" | "sonic" | "ethereum",
        registryType: "UNS" | "CNS",
    ): Promise<UnifiedDomainResolution | null> {
        try {
            const provider = new JsonRpcProvider(rpcUrl)
            const registry = new ethers.Contract(
                registryAddress,
                registryAbi,
                provider,
            )

            const owner = await registry.ownerOf(tokenId)

            // Fetch resolver address (may be registry itself or separate contract)
            let resolverAddress: string
            try {
                resolverAddress = await registry.resolverOf(tokenId)
            } catch {
                resolverAddress = registryAddress
            }

            // Fetch all records from resolver
            const resolver = new ethers.Contract(
                resolverAddress,
                resolverAbi,
                provider,
            )
            const records = await this.fetchDomainRecords(resolver, tokenId)

            log.debug(
                `Domain ${domain} resolved on ${networkName} ${registryType}: owner=${owner}, records=${
                    Object.keys(records).filter(k => records[k]).length
                }/${UD_RECORD_KEYS.length}`,
            )

            // Convert to unified format
            const evmResolution: EVMDomainResolution = {
                domain,
                network: networkName,
                tokenId,
                owner,
                resolver: resolverAddress,
                records,
            }

            return this.evmToUnified(evmResolution, registryType)
        } catch (error) {
            log.debug(
                `${networkName} ${registryType} lookup failed for ${domain}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            )

            return null
        }
    }

    /**
     * Resolve an Unstoppable Domain with full records (PHASE 3: Multi-chain unified resolution)
     *
     * Multi-chain resolution strategy:
     * 1. Try Polygon L2 UNS first (most new domains, cheaper gas)
     * 2. Try Base L2 UNS (new L2 option - growing adoption)
     * 3. Try Sonic (emerging network support)
     * 4. Fallback to Ethereum L1 UNS (legacy domains)
     * 5. Fallback to Ethereum L1 CNS (oldest legacy domains)
     * 6. Fallback to Solana (.demos and other Solana domains)
     *
     * CHANGED (Phase 3): Returns UnifiedDomainResolution supporting both EVM and Solana
     *
     * @param domain - The UD domain (e.g., "brad.crypto" or "partner-engineering.demos")
     * @returns UnifiedDomainResolution with authorized addresses and chain-specific metadata
     */
    public static async resolveUDDomain(
        domain: string,
    ): Promise<UnifiedDomainResolution> {
        // Convert domain to tokenId using namehash algorithm
        const tokenId = namehash(domain)

        // REFACTORED: Try EVM networks in priority order
        // Network priority: Polygon → Base → Sonic → Ethereum UNS → Ethereum CNS
        const evmNetworks = [
            {
                name: "polygon" as const,
                rpc: "https://polygon-rpc.com",
                registry: polygonUnsRegistryAddress,
                type: "UNS" as const,
            },
            {
                name: "base" as const,
                rpc: "https://mainnet.base.org",
                registry: baseUnsRegistryAddress,
                type: "UNS" as const,
            },
            {
                name: "sonic" as const,
                rpc: "https://rpc.soniclabs.com",
                registry: sonicUnsRegistryAddress,
                type: "UNS" as const,
            },
            {
                name: "ethereum" as const,
                rpc: "https://eth.llamarpc.com",
                registry: ethereumUnsRegistryAddress,
                type: "UNS" as const,
            },
            {
                name: "ethereum" as const,
                rpc: "https://eth.llamarpc.com",
                registry: ethereumCnsRegistryAddress,
                type: "CNS" as const,
            },
        ]

        const evmResults = await Promise.allSettled(
            evmNetworks.map(network =>
                this.tryEvmNetwork(
                    domain,
                    tokenId,
                    network.rpc,
                    network.registry,
                    network.name,
                    network.type,
                ),
            ),
        )

        for (const result of evmResults) {
            if (result.status === "fulfilled" && result.value !== null) {
                return result.value
            }
        }

        // PHASE 3: All EVM networks failed, try Solana fallback
        log.debug(`All EVM networks failed for ${domain}, trying Solana`)

        const solanaResolver = new SolanaDomainResolver()
        const solanaResult = await solanaResolver.resolveDomain(
            domain,
            UD_RECORD_KEYS,
        )
        log.debug("solanaResult: " + JSON.stringify(solanaResult))

        if (solanaResult.exists) {
            log.debug(
                `Domain ${domain} resolved on Solana: records=${
                    solanaResult.records.filter(r => r.found).length
                }/${UD_RECORD_KEYS.length}`,
            )
            return this.solanaToUnified(solanaResult)
        } else {
            throw new Error(solanaResult.error || "Domain not found on Solana")
        }
    }

    /**
     * Verify UD domain ownership and signature (PHASE 4: Multi-address verification)
     *
     * This method now supports:
     * - Verification with ANY authorized address in domain records (not just owner)
     * - Both EVM and Solana signature types
     * - Mixed signature types within the same domain
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
            // Phase 5: Updated to use signingAddress + signatureType
            const {
                domain,
                signingAddress,
                signatureType,
                signature,
                signedData,
                network,
                registryType,
            } = payload.payload

            // Step 1: Resolve domain to get all authorized addresses
            const resolution = await this.resolveUDDomain(domain)
            log.debug(
                `Verifying UD domain ${domain}: signing_address=${signingAddress}, signature_type=${signatureType}, network=${resolution.network}, authorized_addresses=${resolution.authorizedAddresses.length}`,
            )

            const isOwner = !!(
                signingAddress ===
                (resolution.metadata[signatureType] || {}).owner
            )

            // Step 2: Check if domain has any authorized addresses
            if (resolution.authorizedAddresses.length === 0 && !isOwner) {
                return {
                    success: false,
                    message: `Domain ${domain} has no authorized addresses in records`,
                }
            }

            // Step 3: Verify network matches (warn if mismatch but allow)
            // SECURITY RATIONALE: network and registryType are optional auto-detected fields.
            // Clients may not know ahead of time which network/registry a domain is on.
            // The critical security validation is whether signingAddress is actually authorized
            // for the domain (Step 5), not which network it was resolved from.
            // Mismatches only indicate the client's hint was incorrect, not a security breach.
            if (network && resolution.network !== network) {
                log.warning(
                    `Network mismatch for ${domain}: claimed=${network}, actual=${resolution.network}. This is informational only - proceeding with actual network.`,
                )
            }

            // Step 4: Verify registry type matches (warn if mismatch but allow)
            if (registryType && resolution.registryType !== registryType) {
                log.warning(
                    `Registry type mismatch for ${domain}: claimed=${registryType}, actual=${resolution.registryType}. This is informational only - proceeding with actual registry type.`,
                )
            }

            // Step 5: Find the authorized address that matches the signing address
            // SECURITY: Solana addresses are case-sensitive (base58), EVM addresses are case-insensitive
            let matchingAddress: SignableAddress | null = null

            if (isOwner) {
                matchingAddress = {
                    address: signingAddress,
                    signatureType: signatureType,
                    recordKey: "domain.owner",
                }
            } else {
                matchingAddress = resolution.authorizedAddresses.find(auth => {
                    // Solana addresses are case-sensitive (base58 encoding)
                    if (auth.signatureType === "solana") {
                        return auth.address === signingAddress
                    }
                    // EVM addresses are case-insensitive
                    return (
                        auth.address.toLowerCase() ===
                        signingAddress.toLowerCase()
                    )
                })
            }

            if (!matchingAddress) {
                // Use original casing in error message
                const authorizedList = resolution.authorizedAddresses
                    .map(a => `${a.address} (${a.recordKey})`)
                    .join(", ")
                return {
                    success: false,
                    message: `Address ${signingAddress} is not authorized for domain ${domain}. Authorized addresses: ${authorizedList}`,
                }
            }

            log.debug(
                `Found matching authorized address: ${matchingAddress.address} (${matchingAddress.signatureType}) from ${matchingAddress.recordKey}`,
            )

            // Step 6: Verify signature based on signature type
            const signatureValid = await this.verifySignature(
                signedData,
                signature,
                matchingAddress,
            )

            if (!signatureValid.success) {
                return signatureValid
            }

            // Step 7: Verify challenge contains correct Demos public key
            // SECURITY: Use strict validation instead of substring matching to prevent attacks
            // Expected format: "Link {signingAddress} to Demos identity {demosPublicKey}\n..."
            try {
                // Allow optional 0x prefix in the challenge message
                const demosIdentityRegex =
                    /Link .+ to Demos identity (?:0x)?([a-fA-F0-9]+)/
                const match = signedData.match(demosIdentityRegex)

                // Normalize both values by removing 0x prefix and lowercasing for comparison
                const normalizedMatch = match?.[1]
                    ?.replace(/^0x/i, "")
                    .toLowerCase()
                const normalizedSender = sender
                    .replace(/^0x/i, "")
                    .toLowerCase()

                if (!match || normalizedMatch !== normalizedSender) {
                    return {
                        success: false,
                        message:
                            "Challenge message does not contain correct Demos public key or format is invalid",
                    }
                }
            } catch (error) {
                log.error(
                    `Error parsing challenge message for sender validation: ${error}`,
                )
                return {
                    success: false,
                    message:
                        "Invalid challenge message format - could not verify Demos public key",
                }
            }

            log.info(
                `UD identity verified for domain ${domain}: signed by ${matchingAddress.address} (${matchingAddress.signatureType}) via ${resolution.network} ${resolution.registryType} registry`,
            )

            const isOwnerLinked = await this.checkOwnerLinkedWallets(
                sender,
                domain,
                signingAddress,
                resolution,
            )

            return {
                success: true,
                message:
                    `Verified ownership of ${domain} via ${matchingAddress.signatureType} signature from ${matchingAddress.recordKey}. ` +
                    (!isOwnerLinked
                        ? "Domain not owned by any of the linked wallets, won't award points"
                        : "Awarding points"),
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
     * Verify a signature based on signature type (PHASE 4: EVM + Solana support)
     *
     * @param signedData - The message that was signed
     * @param signature - The signature to verify
     * @param authorizedAddress - The authorized address with signature type
     * @returns Verification result
     */
    private static async verifySignature(
        signedData: string,
        signature: string,
        authorizedAddress: SignableAddress,
    ): Promise<{ success: boolean; message: string }> {
        try {
            if (authorizedAddress.signatureType === "evm") {
                // EVM signature verification using ethers
                const recoveredAddress = verifyMessage(signedData, signature)

                if (
                    recoveredAddress.toLowerCase() !==
                    authorizedAddress.address.toLowerCase()
                ) {
                    return {
                        success: false,
                        message: `EVM signature verification failed: signed by ${recoveredAddress}, expected ${authorizedAddress.address}`,
                    }
                }

                return { success: true, message: "EVM signature valid" }
            }

            if (authorizedAddress.signatureType === "solana") {
                // Solana signature verification using nacl
                // Solana uses base58 encoding for addresses and signatures
                const solana = new SOLANA(null)
                const isValid = await solana.verifyMessage(
                    signedData,
                    signature,
                    authorizedAddress.address,
                )

                if (!isValid) {
                    return {
                        success: false,
                        message: `Solana signature verification failed for address ${authorizedAddress.address}`,
                    }
                }

                return { success: true, message: "Solana signature valid" }
            }

            return {
                success: false,
                message: `Unsupported signature type: ${authorizedAddress.signatureType}`,
            }
        } catch (error) {
            log.error(`Error verifying UD domain signature: ${error}`)
            return {
                success: false,
                message: `Signature verification error: ${error}`,
            }
        }
    }

    /**
     * Check if the owner is linked to the signer
     *
     * @param address - The Demos address
     * @param domain - The UD domain
     * @param resolutionData - The resolution data (optional)
     * @returns True if the owner is linked to the signer, false otherwise
     */
    static async checkOwnerLinkedWallets(
        address: string,
        domain: string,
        signer: string,
        resolutionData?: UnifiedDomainResolution,
        identities?: Record<string, Record<string, Record<string, any>[]>>,
    ): Promise<boolean> {
        if (!resolutionData) {
            resolutionData = await this.resolveUDDomain(domain)
        }

        if (!identities) {
            identities = await IdentityManager.getIdentities(address, "xm")
        }

        const accounts: Set<string> = new Set()

        // TODO: Refactor after updating GCR xm map to use "chain.subchain" format
        for (const chainType in identities) {
            for (const network in identities[chainType]) {
                if (network !== "mainnet") {
                    continue
                }

                for (const identity of identities[chainType][network]) {
                    if (identity.address) {
                        accounts.add(identity.address)
                    }
                }
            }
        }

        // INFO: Check if a connected record is connected to demos account
        for (const address of resolutionData.authorizedAddresses) {
            if (accounts.has(address.address)) {
                return true
            }
        }

        const network = detectSignatureType(signer)
        if (!network) {
            throw new Error("Invalid signer address format")
        }

        // INFO: Return true if the domain owner is linked
        if (
            resolutionData.metadata[network].owner === signer &&
            accounts.has(signer)
        ) {
            return true
        }

        return false
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
