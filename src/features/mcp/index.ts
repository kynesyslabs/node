/**
 * MCP (Model Context Protocol) Integration for Demos Network
 *
 * This module provides comprehensive MCP server functionality for the Demos Network,
 * enabling AI assistants and other clients to interact with blockchain operations,
 * network status, peer management, and other node capabilities.
 *
 * Features:
 * - Dual transport support (stdio for local, SSE for remote access)
 * - Comprehensive blockchain tools (blocks, transactions, chain status)
 * - Network monitoring and node identity tools
 * - Peer management and discovery tools
 * - Full MCP protocol compliance
 *
 * @fileoverview Main exports for Demos Network MCP integration
 *
 * @example
 * ```typescript
 * import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"
 *
 * // Create server with remote access
 * const server = createDemosMCPServer({
 *   transport: "sse",
 *   port: 3001,
 *   host: "0.0.0.0"
 * })
 *
 * // Add all Demos Network tools
 * const tools = createDemosNetworkTools()
 * tools.forEach(tool => server.registerTool(tool))
 *
 * // Start the server
 * await server.start()
 * ```
 */

// Core MCP server functionality
export {
    MCPServerManager,
    createDemosMCPServer,
    type MCPServerConfig,
    type MCPTool,
    type MCPTransportType,
} from "./MCPServer"

// Demos Network specific tools
export {
    createDemosNetworkTools,
    type DemosNetworkToolsConfig,
} from "./tools/demosTools"

// Re-export commonly used types from MCP SDK for convenience
export type {
    Tool,
    ServerCapabilities,
    CallToolRequest,
    ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js"
