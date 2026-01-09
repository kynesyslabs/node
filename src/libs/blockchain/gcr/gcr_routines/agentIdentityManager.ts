import { ethers, JsonRpcProvider } from "ethers"

import log from "@/utilities/logger"
import ensureGCRForUser from "./ensureGCRForUser"
import {
    SavedAgentIdentity,
    DemosOwnershipProof,
    AgentIdentityAssignPayload,
} from "@/model/entities/types/IdentityTypes"
import { hexToUint8Array, ucrypto } from "@kynesyslabs/demosdk/encryption"

/**
 * AgentIdentityManager - Handles ERC-8004 Agent identity verification and storage
 *
 * Verification Flow:
 * 1. User has an ERC-8004 agent NFT on Base Sepolia
 * 2. User signs ownership proof with their Demos wallet
 * 3. Verify EVM address owns the agent NFT on-chain
 * 4. Verify the Demos ownership proof signature
 * 5. Store agent identity in GCR database
 *
 * Pattern: Follows UD/XM signature-based verification
 */

// ERC-8004 IdentityRegistry contract on Base Sepolia
const AGENT_REGISTRY_ADDRESS = "0x8004AA63c570c570eBF15376c0dB199918BFe9Fb"

// Base Sepolia configuration
const BASE_SEPOLIA_CONFIG = {
    chainId: 84532,
    chain: "base",
    subchain: "sepolia",
    rpc: "https://sepolia.base.org",
}

// Multiple RPC endpoints for failover (public endpoints)
const BASE_SEPOLIA_RPC_ENDPOINTS = [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.blockpi.network/v1/rpc/public",
]

const registryAbi = [
    "function ownerOf(uint256 tokenId) external view returns (address)",
    "function tokenURI(uint256 tokenId) external view returns (string)",
]

export class AgentIdentityManager {
    constructor() { }

    /**
     * Verify agent NFT ownership on Base Sepolia
     *
     * @param agentId - The ERC-8004 token ID
     * @param expectedOwner - The expected EVM address owner
     * @returns True if the address owns the agent, false otherwise
     */
    static async verifyAgentOwnership(
        agentId: string,
        expectedOwner: string,
    ): Promise<{ success: boolean; message: string; actualOwner?: string }> {
        for (const rpcUrl of BASE_SEPOLIA_RPC_ENDPOINTS) {
            try {
                const provider = new JsonRpcProvider(rpcUrl)
                const contract = new ethers.Contract(
                    AGENT_REGISTRY_ADDRESS,
                    registryAbi,
                    provider,
                )

                const owner = await contract.ownerOf(agentId)

                if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
                    return {
                        success: false,
                        message: `Agent NFT ${agentId} is owned by ${owner}, not ${expectedOwner}`,
                        actualOwner: owner,
                    }
                }

                return {
                    success: true,
                    message: `Verified ownership of agent ${agentId} by ${owner}`,
                    actualOwner: owner,
                }
            } catch (error) {
                log.debug(
                    `Failed to verify agent ownership via ${rpcUrl}: ${error}`,
                )
                continue
            }
        }

        return {
            success: false,
            message: `Failed to verify agent ownership on all RPC endpoints. Agent ${agentId} may not exist.`,
        }
    }

    /**
     * Verify Demos ownership proof signature
     *
     * The proof contains:
     * - message: "I authorize EVM address {evmAddress} to register an ERC-8004 agent for Demos identity {demosPublicKey}. Timestamp: {timestamp}"
     * - signature: Signed by Demos wallet (ed25519 or other supported algorithm)
     * - demosPublicKey: The Demos identity's ed25519 public key
     *
     * @param proof - The ownership proof
     * @param sender - The sender's ed25519 address from transaction
     * @returns Verification result
     */
    static async verifyOwnershipProof(
        proof: DemosOwnershipProof,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        try {
            // Verify the proof type
            if (proof.type !== "demos-signature") {
                return {
                    success: false,
                    message: `Invalid proof type: ${proof.type}, expected "demos-signature"`,
                }
            }

            // Verify the message contains the correct Demos public key
            // Expected format: "I authorize EVM address {evmAddress} to register an ERC-8004 agent for Demos identity {demosPublicKey}..."
            const demosIdentityRegex =
                /for Demos identity (?:0x)?([a-fA-F0-9]+)/
            const match = proof.message.match(demosIdentityRegex)

            if (!match) {
                return {
                    success: false,
                    message: "Proof message does not contain Demos identity",
                }
            }

            // Normalize both for comparison (remove 0x prefix, lowercase)
            const normalizedMatch = match[1].replace(/^0x/i, "").toLowerCase()
            const normalizedSender = sender.replace(/^0x/i, "").toLowerCase()

            if (normalizedMatch !== normalizedSender) {
                return {
                    success: false,
                    message: `Proof Demos identity ${match[1]} does not match sender ${sender}`,
                }
            }

            // Verify the proof demosPublicKey matches sender
            const normalizedProofKey = proof.demosPublicKey
                .replace(/^0x/i, "")
                .toLowerCase()

            if (normalizedProofKey !== normalizedSender) {
                return {
                    success: false,
                    message: `Proof demosPublicKey ${proof.demosPublicKey} does not match sender ${sender}`,
                }
            }

            // Verify the signature
            let signatureHex: string
            let algorithm: string

            if (typeof proof.signature === "string") {
                signatureHex = proof.signature
                algorithm = "ed25519" // Default to ed25519
            } else {
                signatureHex = proof.signature.data
                algorithm = proof.signature.type
            }

            // Verify using ucrypto with object signature
            const isValid = await ucrypto.verify({
                algorithm: algorithm as "ed25519" | "ml-dsa" | "falcon",
                message: new TextEncoder().encode(proof.message),
                signature: hexToUint8Array(signatureHex.replace(/^0x/i, "")),
                publicKey: hexToUint8Array(sender.replace(/^0x/i, "")),
            })

            if (!isValid) {
                return {
                    success: false,
                    message: "Ownership proof signature verification failed",
                }
            }

            return {
                success: true,
                message: "Ownership proof verified successfully",
            }
        } catch (error) {
            log.error(`Error verifying ownership proof: ${error}`)
            return {
                success: false,
                message: `Ownership proof verification error: ${error}`,
            }
        }
    }

    /**
     * Verify agent identity payload
     *
     * This method verifies:
     * 1. The EVM address owns the agent NFT on Base Sepolia
     * 2. The ownership proof signature is valid
     * 3. The proof contains the correct Demos public key
     *
     * @param payload - The agent identity payload from transaction
     * @param sender - The ed25519 address from transaction body
     * @returns Verification result with success status and message
     */
    static async verifyPayload(
        payload: AgentIdentityAssignPayload,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        try {
            const { agentId, evmAddress, chain, txHash, tokenUri, proof } =
                payload.payload

            // Validate required fields
            if (!agentId) {
                return {
                    success: false,
                    message: "Agent ID is required",
                }
            }

            if (!evmAddress) {
                return {
                    success: false,
                    message: "EVM address is required",
                }
            }

            if (!proof) {
                return {
                    success: false,
                    message: "Ownership proof is required",
                }
            }

            // Validate EVM address format
            const evmPattern = /^0x[0-9a-fA-F]{40}$/
            if (!evmPattern.test(evmAddress)) {
                return {
                    success: false,
                    message: `Invalid EVM address format: ${evmAddress}`,
                }
            }

            // Verify proof EVM address matches payload EVM address
            if (proof.evmAddress.toLowerCase() !== evmAddress.toLowerCase()) {
                return {
                    success: false,
                    message: `Proof EVM address ${proof.evmAddress} does not match payload EVM address ${evmAddress}`,
                }
            }

            // Step 1: Verify ownership proof signature
            log.debug(
                `Verifying ownership proof for agent ${agentId} by Demos identity ${sender}`,
            )
            const proofResult = await this.verifyOwnershipProof(proof, sender)
            if (!proofResult.success) {
                return proofResult
            }

            // Step 2: Verify on-chain agent NFT ownership
            log.debug(
                `Verifying on-chain ownership of agent ${agentId} by ${evmAddress}`,
            )
            const ownershipResult = await this.verifyAgentOwnership(
                agentId,
                evmAddress,
            )
            if (!ownershipResult.success) {
                return ownershipResult
            }

            log.info(
                `Agent identity verified: agent=${agentId}, evmAddress=${evmAddress}, demos=${sender}, chain=${chain}`,
            )

            return {
                success: true,
                message: `Verified agent ${agentId} ownership by ${evmAddress} linked to Demos identity ${sender}`,
            }
        } catch (error) {
            log.error(`Error verifying agent payload: ${error}`)
            return {
                success: false,
                message: `Verification error: ${error}`,
            }
        }
    }

    /**
     * Get agent identities for a Demos address
     *
     * @param address - The Demos address
     * @param chain - Optional chain filter (e.g., "base.sepolia")
     * @returns Array of saved agent identities
     */
    static async getAgentIdentities(
        address: string,
        chain?: string,
    ): Promise<SavedAgentIdentity[]> {
        const gcr = await ensureGCRForUser(address)

        // Defensive initialization for backward compatibility
        if (!gcr.identities.agent) {
            return []
        }

        if (chain) {
            return gcr.identities.agent[chain] || []
        }

        // Return all agent identities across all chains
        const allAgents: SavedAgentIdentity[] = []
        for (const chainKey of Object.keys(gcr.identities.agent)) {
            allAgents.push(...(gcr.identities.agent[chainKey] || []))
        }

        return allAgents
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

    /**
     * Get configuration for agent identity
     */
    static getConfig() {
        return {
            registryAddress: AGENT_REGISTRY_ADDRESS,
            ...BASE_SEPOLIA_CONFIG,
        }
    }
}
