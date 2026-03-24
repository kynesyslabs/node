/**
 * Remote MCP Server Example for Demos Network
 *
 * This example demonstrates how to set up the MCP server with SSE transport
 * for remote network access, allowing clients from other machines to connect.
 *
 * @fileoverview Examples for setting up MCP servers with remote network access
 */

import { createDemosMCPServer, createDemosNetworkTools } from "../index"
import log from "@/utilities/logger"

/**
 * Sets up an MCP server with SSE transport for remote network access
 *
 * Creates an HTTP server with Server-Sent Events endpoints that allow
 * remote MCP clients to connect and interact with the Demos Network.
 *
 * @param port - Port number to listen on (default: 3001)
 * @param host - Host address to bind to (default: "0.0.0.0" for all interfaces)
 * @returns Promise resolving to the configured MCP server instance
 *
 * @example
 * ```typescript
 * // Start remote server on all interfaces
 * const server = await setupRemoteMCPServer(3001, "0.0.0.0")
 *
 * // Clients can connect to:
 * // - SSE stream: http://your-ip:3001/sse
 * // - Messages: POST http://your-ip:3001/message
 * ```
 */
export async function setupRemoteMCPServer(port = 3001, host = "0.0.0.0") {
    try {
        // Create MCP server instance with SSE transport for remote access
        const mcpServer = createDemosMCPServer({
            port,
            host,
            transport: "sse",
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

        log.info(`[MCP] Remote MCP server started on http://${host}:${port}`)
        log.info(`[MCP] SSE endpoint: http://${host}:${port}/sse`)
        log.info("[MCP] Remote clients can now connect to this MCP server")

        return mcpServer
    } catch (error) {
        log.error(`[MCP] Failed to setup remote MCP server: ${String(error)}`)
        throw error
    }
}

/**
 * Sets up an MCP server with stdio transport for local process communication
 *
 * Creates a standard MCP server that communicates via stdin/stdout,
 * suitable for local MCP clients like Claude Desktop.
 *
 * @returns Promise resolving to the configured MCP server instance
 *
 * @example
 * ```typescript
 * // Start local server (stdio transport)
 * const server = await setupLocalMCPServer()
 *
 * // This server can be used by local MCP clients that spawn
 * // the process and communicate via stdin/stdout
 * ```
 */
export async function setupLocalMCPServer() {
    try {
        // Create MCP server instance with stdio transport (default)
        const mcpServer = createDemosMCPServer({
            transport: "stdio",
        })

        // Create and register Demos Network tools
        const demosTools = createDemosNetworkTools()

        // Register all tools
        for (const tool of demosTools) {
            mcpServer.registerTool(tool)
        }

        // Start the server
        await mcpServer.start()

        log.info("[MCP] Local MCP server started (stdio transport)")

        return mcpServer
    } catch (error) {
        log.error(`[MCP] Failed to setup local MCP server: ${String(error)}`)
        throw error
    }
}

export default setupRemoteMCPServer
