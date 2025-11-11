/**
 * MCP Server Manager for Demos Network
 *
 * This class provides a unified interface to manage MCP (Model Context Protocol) servers
 * for the Demos Network node. It handles server lifecycle, tool registration, and
 * communication with MCP clients.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
    ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import log from "@/utilities/logger"
import express from "express"
import helmet from "helmet"
import cors from "cors"
import http from "http"

export type MCPTransportType = "stdio" | "sse"

export interface MCPServerConfig {
    name: string
    version: string
    description?: string
    capabilities?: Partial<ServerCapabilities>
    transport?: {
        type: MCPTransportType
        port?: number
        host?: string
    }
}

export interface MCPTool {
    name: string
    description: string
    inputSchema: z.ZodSchema<any>
    handler: (args: any) => Promise<any>
}

/**
 * MCPServerManager - Manages MCP server lifecycle and tool registration
 *
 * This class provides methods to:
 * - Start and stop MCP servers
 * - Register tools and handlers
 * - Manage server capabilities
 * - Handle client connections
 */
export class MCPServerManager {
    private server: Server | null = null
    private transport: StdioServerTransport | SSEServerTransport | null = null
    private expressApp: express.Application | null = null
    private httpServer: http.Server | null = null
    private tools: Map<string, MCPTool> = new Map()
    private isRunning = false
    private config: MCPServerConfig

    constructor(config: MCPServerConfig) {
        this.config = {
            capabilities: {
                resources: {},
                tools: {},
                prompts: {},
                logging: {},
            },
            transport: {
                type: "stdio",
                port: 3001,
                host: "localhost",
            },
            ...config,
        }
    }

    /**
     * Initialize the MCP server with the provided configuration
     */
    private initializeServer(): void {
        if (this.server) {
            throw new Error("MCP Server is already initialized")
        }

        this.server = new Server(
            {
                name: this.config.name,
                version: this.config.version,
                description: this.config.description,
            },
            {
                capabilities: this.config.capabilities as ServerCapabilities,
            },
        )

        this.setupServerHandlers()
        log.info(
            `[MCP] Server initialized: ${this.config.name} v${this.config.version}`,
        )
    }

    /**
     * Setup default server handlers for tools and other capabilities
     */
    private setupServerHandlers(): void {
        if (!this.server) {
            throw new Error("Server not initialized")
        }

        // Handle tool listing requests
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const toolList: Tool[] = Array.from(this.tools.values()).map(
                tool => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema._def as any,
                }),
            )

            return { tools: toolList }
        })

        // Handle tool execution requests
        this.server.setRequestHandler(CallToolRequestSchema, async request => {
            const { name, arguments: args } = request.params

            const tool = this.tools.get(name)
            if (!tool) {
                throw new Error(`Tool '${name}' not found`)
            }

            try {
                // Validate input arguments
                const validatedArgs = tool.inputSchema.parse(args)

                // Execute the tool handler
                const result = await tool.handler(validatedArgs)

                log.info(`[MCP] Tool '${name}' executed successfully`)

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                }
            } catch (error: any) {
                log.error(
                    `[MCP] Tool '${name}' execution failed: ${String(error)}`,
                )
                const errorMessage =
                    error instanceof Error ? error.message : String(error)
                throw new Error(`Tool execution failed: ${errorMessage}`)
            }
        })
    }

    /**
     * Register a new tool with the MCP server
     *
     * @param tool - The tool configuration and handler
     */
    public registerTool(tool: MCPTool): void {
        if (this.isRunning) {
            throw new Error("Cannot register tools while server is running")
        }

        this.tools.set(tool.name, tool)
        log.info(`[MCP] Tool registered: ${tool.name}`)
    }

    /**
     * Unregister a tool from the MCP server
     *
     * @param toolName - Name of the tool to unregister
     */
    public unregisterTool(toolName: string): void {
        if (this.isRunning) {
            throw new Error("Cannot unregister tools while server is running")
        }

        if (this.tools.delete(toolName)) {
            log.info(`[MCP] Tool unregistered: ${toolName}`)
        } else {
            log.warning(`[MCP] Tool not found for unregistration: ${toolName}`)
        }
    }

    /**
     * Start the MCP server and begin listening for connections
     * 
     * Supports both stdio (local) and SSE (remote network) transports.
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("MCP Server is already running")
        }

        try {
            // Initialize server if not already done
            if (!this.server) {
                this.initializeServer()
            }

            // Create appropriate transport
            if (this.config.transport?.type === "sse") {
                await this.startSSEServer()
            } else {
                await this.startStdioServer()
            }

            this.isRunning = true
            log.info(`[MCP] Server started successfully: ${this.config.name}`)
            log.info(
                `[MCP] Transport: ${this.config.transport?.type || "stdio"}${
                    this.config.transport?.type === "sse"
                        ? ` on ${this.config.transport.host}:${this.config.transport.port}`
                        : ""
                }`,
            )
            log.info(
                `[MCP] Registered tools: ${Array.from(this.tools.keys()).join(
                    ", ",
                )}`,
            )
        } catch (error) {
            log.error(`[MCP] Failed to start server: ${String(error)}`)
            const errorMessage =
                error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to start MCP server: ${errorMessage}`)
        }
    }

    /**
     * Start the server with stdio transport (local)
     */
    private async startStdioServer(): Promise<void> {
        this.transport = new StdioServerTransport()
        if (this.server) {
            await this.server.connect(this.transport)
        }
    }

    /**
     * Start the server with SSE transport (remote network access)
     */
    private async startSSEServer(): Promise<void> {
        const port = this.config.transport?.port || 3001
        const host = this.config.transport?.host || "localhost"

        // Create Express app for SSE transport
        this.expressApp = express()
        this.expressApp.use(helmet())
        this.expressApp.use(cors())
        this.expressApp.use(express.json())

        // Create HTTP server
        this.httpServer = http.createServer(this.expressApp)

        // Handle SSE connections
        this.expressApp.get("/sse", (req, res) => {
            // Set SSE headers
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Cache-Control",
            })

            // Create SSE transport for this connection
            const sseTransport = new SSEServerTransport("/message", res)
            
            // Connect server to this SSE transport
            if (this.server) {
                this.server.connect(sseTransport).catch((error) => {
                log.error(`[MCP] Failed to connect SSE transport: ${String(error)}`)
                    res.end()
                })
            }

            // Store the transport (note: in a real implementation, you'd manage multiple connections)
            if (!this.transport) {
                this.transport = sseTransport
            }

            // Handle client disconnect
            req.on("close", () => {
                log.info("[MCP] SSE client disconnected")
                sseTransport.close().catch(console.error)
            })
        })

        // Handle POST messages (for client to server communication)
        this.expressApp.post("/message", (_req, res) => {
            try {
                // Forward message to current SSE transport
                if (this.transport instanceof SSEServerTransport) {
                    // The message handling is done internally by the transport
                    res.json({ status: "received" })
                } else {
                    res.status(500).json({ error: "No SSE transport available" })
                }
            } catch (error) {
                log.error(`[MCP] Error handling message: ${String(error)}`)
                res.status(500).json({ error: "Message handling failed" })
            }
        })

        // Start HTTP server
        await new Promise<void>((resolve, reject) => {
            if (this.httpServer) {
                this.httpServer.listen(port, host, () => {
                log.info(`[MCP] SSE server listening on http://${host}:${port}`)
                log.info(`[MCP] SSE endpoint: http://${host}:${port}/sse`)
                log.info(`[MCP] Message endpoint: http://${host}:${port}/message`)
                resolve()
                })

                this.httpServer.on("error", (error) => {
                    reject(error)
                })
            }
        })
    }

    /**
     * Stop the MCP server and cleanup resources
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            log.warning("[MCP] Server is not running")
            return
        }

        try {
            if (this.server) {
                await this.server.close()
                this.server = null
            }

            if (this.transport) {
                await this.transport.close()
                this.transport = null
            }

            // Close HTTP server if using SSE transport
            if (this.httpServer) {
                await new Promise<void>((resolve, reject) => {
                    this.httpServer.close((error?: Error) => {
                        if (error) {
                            reject(error)
                        } else {
                            resolve()
                        }
                    })
                })
                this.httpServer = null
            }

            this.expressApp = null
            this.isRunning = false
            log.info("[MCP] Server stopped successfully")
        } catch (error) {
            log.error(`[MCP] Error stopping server: ${String(error)}`)
            const errorMessage =
                error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to stop MCP server: ${errorMessage}`)
        }
    }

    /**
     * Get the current server status
     */
    public getStatus(): {
        isRunning: boolean
        toolCount: number
        serverName: string
        serverVersion: string
    } {
        return {
            isRunning: this.isRunning,
            toolCount: this.tools.size,
            serverName: this.config.name,
            serverVersion: this.config.version,
        }
    }

    /**
     * Get list of registered tools
     */
    public getRegisteredTools(): string[] {
        return Array.from(this.tools.keys())
    }

    /**
     * Handle graceful shutdown
     */
    public async shutdown(): Promise<void> {
        log.info("[MCP] Initiating graceful shutdown...")

        if (this.isRunning) {
            await this.stop()
        }

        // Clear all registered tools
        this.tools.clear()

        log.info("[MCP] Graceful shutdown completed")
    }
}

/**
 * Factory function to create a pre-configured MCP server for Demos Network
 */
export function createDemosMCPServer(options?: {
    port?: number
    host?: string
    transport?: MCPTransportType
}): MCPServerManager {
    const config: MCPServerConfig = {
        name: "demos-network-mcp",
        version: "1.0.0",
        description:
            "MCP Server for Demos Network - providing blockchain and network tools",
        capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            logging: {},
        },
        transport: {
            type: options?.transport || "stdio",
            port: options?.port || 3001,
            host: options?.host || "localhost",
        },
    }

    return new MCPServerManager(config)
}

export default MCPServerManager
