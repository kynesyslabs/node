/**
 * Demos Network MCP Tools
 *
 * This module provides MCP tools specific to Demos Network operations,
 * including blockchain queries, network status, and node management.
 * 
 * @fileoverview MCP tools for interacting with Demos Network blockchain and infrastructure
 */

import { z } from "zod"
import { MCPTool } from "../MCPServer"
import { getSharedState } from "@/utilities/sharedState"
import { PeerManager } from "@/libs/peer"
import Chain from "@/libs/blockchain/chain"
import log from "@/utilities/logger"

/**
 * Configuration options for Demos Network MCP tools
 */
export interface DemosNetworkToolsConfig {
    /** Enable blockchain-related tools (default: true) */
    enableBlockchainTools?: boolean
    /** Enable network status tools (default: true) */
    enableNetworkTools?: boolean
    /** Enable peer management tools (default: true) */
    enablePeerTools?: boolean
}

/**
 * Creates a comprehensive set of MCP tools for Demos Network operations
 * 
 * Provides tools for:
 * - Blockchain queries (blocks, chain height, etc.)
 * - Network status monitoring
 * - Peer management and discovery
 * 
 * @param config - Configuration to enable/disable specific tool categories
 * @returns Array of configured MCP tools ready for registration
 * 
 * @example
 * ```typescript
 * // Create all available tools
 * const allTools = createDemosNetworkTools()
 * 
 * // Create only blockchain tools
 * const blockchainTools = createDemosNetworkTools({
 *   enableBlockchainTools: true,
 *   enableNetworkTools: false,
 *   enablePeerTools: false
 * })
 * ```
 */
export function createDemosNetworkTools(
    config: DemosNetworkToolsConfig = {},
): MCPTool[] {
    const {
        enableBlockchainTools = true,
        enableNetworkTools = true,
        enablePeerTools = true,
    } = config

    const tools: MCPTool[] = []

    if (enableNetworkTools) {
        tools.push(...createNetworkTools())
    }

    if (enableBlockchainTools) {
        tools.push(...createBlockchainTools())
    }

    if (enablePeerTools) {
        tools.push(...createPeerTools())
    }

    return tools
}

/**
 * Creates network status and node identity MCP tools
 * 
 * @returns Array of network-related MCP tools
 * @internal
 */
function createNetworkTools(): MCPTool[] {
    return [
        {
            name: "get_network_status",
            description:
                "Get current network status including server port, connection string, and basic node info",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const sharedState = getSharedState
                    return {
                        serverPort: sharedState.serverPort,
                        connectionString: sharedState.connectionString,
                        signingAlgorithm: sharedState.signingAlgorithm,
                        isSignalingServerStarted:
                            sharedState.isSignalingServerStarted,
                        lastBlockNumber: sharedState.lastBlockNumber,
                        lastBlockHash: sharedState.lastBlockHash,
                        rpcFee: sharedState.rpcFee,
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting network status: ${String(error)}`)
                    throw new Error("Failed to get network status")
                }
            },
        },
        {
            name: "get_node_identity",
            description:
                "Get the node's identity information including public key",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const identity = getSharedState.identity
                    const keypair = getSharedState.keypair

                    return {
                        publicKey: keypair?.publicKey
                            ? Array.from(keypair.publicKey as Uint8Array)
                            : null,
                        publicIP: identity.publicIP,
                        signingAlgorithm: getSharedState.signingAlgorithm,
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting node identity: ${String(error)}`)
                    throw new Error("Failed to get node identity")
                }
            },
        },
    ]
}

/**
 * Creates blockchain query and block information MCP tools
 * 
 * @returns Array of blockchain-related MCP tools
 * @internal
 */
function createBlockchainTools(): MCPTool[] {
    return [
        {
            name: "get_last_block",
            description: "Get information about the last block in the chain",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const lastBlock = await Chain.getLastBlock()
                    return {
                        number: lastBlock.number,
                        hash: lastBlock.hash,
                        proposer: String(lastBlock.proposer),
                        status: lastBlock.status,
                        content: lastBlock.content,
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting last block: ${String(error)}`)
                    throw new Error("Failed to get last block")
                }
            },
        },
        {
            name: "get_block_by_number",
            description: "Get block information by block number",
            inputSchema: z.object({
                blockNumber: z
                    .number()
                    .min(0)
                    .describe("The block number to retrieve"),
            }),
            handler: async (args: { blockNumber: number }) => {
                try {
                    const block = await Chain.getBlockByNumber(args.blockNumber)
                    if (!block) {
                        throw new Error(`Block ${args.blockNumber} not found`)
                    }

                    return {
                        number: block.number,
                        hash: block.hash,
                        proposer: String(block.proposer),
                        status: block.status,
                        content: block.content,
                    }
                } catch (error) {
                    log.error(
                        `[MCP] Error getting block ${args.blockNumber}: ${String(error)}`,
                    )
                    throw new Error(`Failed to get block ${args.blockNumber}`)
                }
            },
        },
        {
            name: "get_chain_height",
            description:
                "Get the current height (number of blocks) of the blockchain",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const lastBlock = await Chain.getLastBlock()
                    return {
                        height: lastBlock.number,
                        lastBlockHash: lastBlock.hash,
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting chain height: ${String(error)}`)
                    throw new Error("Failed to get chain height")
                }
            },
        },
    ]
}

/**
 * Creates peer management and network discovery MCP tools
 * 
 * @returns Array of peer-related MCP tools
 * @internal
 */
function createPeerTools(): MCPTool[] {
    return [
        {
            name: "get_peer_list",
            description: "Get list of connected peers",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const peerManager = PeerManager.getInstance()
                    const peers = peerManager.getPeers()

                    return {
                        peerCount: peers.length,
                        peers: peers.map(peer => ({
                            identity: peer.identity,
                            connectionString: peer.connection.string,
                            isConnected: true, // Assuming connected if in the list
                        })),
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting peer list: ${String(error)}`)
                    throw new Error("Failed to get peer list")
                }
            },
        },
        {
            name: "get_peer_count",
            description: "Get the number of connected peers",
            inputSchema: z.object({}),
            handler: async () => {
                try {
                    const peerManager = PeerManager.getInstance()
                    const peers = peerManager.getPeers()

                    return {
                        peerCount: peers.length,
                    }
                } catch (error) {
                    log.error(`[MCP] Error getting peer count: ${String(error)}`)
                    throw new Error("Failed to get peer count")
                }
            },
        },
    ]
}

