/**
 * Simple MCP Server Example for Demos Network
 *
 * This example demonstrates how to set up and use the MCP server
 * with the Demos Network node, supporting both local and remote access.
 *
 * @fileoverview Basic MCP server setup with configurable transport options
 */

import { createDemosMCPServer, createDemosNetworkTools } from "../index"
import log from "@/utilities/logger"

/**
 * Example: Setting up MCP server with Demos Network tools
 *
 * @param options - Configuration options for the MCP server
 * @param options.port - Port number for SSE transport (default: 3001)
 * @param options.host - Host address for SSE transport (default: "localhost")
 * @param options.transport - Transport type: "stdio" for local, "sse" for remote
 * @returns Promise resolving to the configured MCP server instance
 *
 * @example
 * ```typescript
 * // Local MCP server (stdio transport)
 * const localServer = await setupDemosMCPServer({ transport: "stdio" })
 *
 * // Remote MCP server (SSE transport)
 * const remoteServer = await setupDemosMCPServer({
 *   transport: "sse",
 *   port: 3001,
 *   host: "0.0.0.0"
 * })
 * ```
 */
export async function setupDemosMCPServer(options?: {
    port?: number
    host?: string
    transport?: "stdio" | "sse"
}) {
    try {
        // Create MCP server instance with optional transport configuration
        const mcpServer = createDemosMCPServer({
            port: options?.port,
            host: options?.host,
            transport: options?.transport,
        })

        // Create and register Demos Network tools
        const demosTools = createDemosNetworkTools({
            enableBlockchainTools: true,
            enableNetworkTools: true,
            enablePeerTools: true,
        })

        // Register all tools
        for (const tool of demosTools) {
            mcpServer.registerTool(tool)
        }

        // Start the server
        await mcpServer.start()

        log.info("[MCP] Demos MCP server started successfully")

        // Return server instance for management
        return mcpServer
    } catch (error) {
        log.error(`[MCP] Failed to setup Demos MCP server: ${String(error)}`)
        throw error
    }
}

/**
 * Gracefully shutdown an MCP server instance
 *
 * Performs cleanup operations including:
 * - Stopping the server transport
 * - Closing network connections (for SSE transport)
 * - Clearing registered tools
 *
 * @param mcpServer - The MCP server instance to shutdown
 * @throws {Error} If shutdown fails
 *
 * @example
 * ```typescript
 * const server = await setupDemosMCPServer()
 * // ... use server ...
 * await shutdownDemosMCPServer(server)
 * ```
 */
export async function shutdownDemosMCPServer(mcpServer: any) {
    try {
        await mcpServer.shutdown()
        log.info("[MCP] Demos MCP server shut down successfully")
    } catch (error) {
        log.error(`[MCP] Error during MCP server shutdown: ${String(error)}`)
        throw error
    }
}

export default setupDemosMCPServer
