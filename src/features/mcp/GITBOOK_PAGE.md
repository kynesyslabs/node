# MCP Integration for Demos Network

The Model Context Protocol (MCP) integration enables AI assistants and external applications to interact with Demos Network nodes through a standardized protocol. This integration provides both local and remote access capabilities, making it easy to build AI-powered applications that can query blockchain data, monitor network status, and manage peer connections.

## Overview

MCP (Model Context Protocol) is an open standard that allows AI assistants to connect to external data sources and tools. The Demos Network MCP integration provides:

- **Dual Transport Support**: stdio for local applications, SSE for remote network access
- **Comprehensive Tools**: blockchain queries, network monitoring, and peer management
- **Production Ready**: Full error handling, logging, and security considerations
- **Type Safe**: Complete TypeScript support with runtime validation

## Quick Start

### Basic Local Setup

For local development and testing, you can quickly start an MCP server with stdio transport:

{% code title="Basic MCP Server Setup" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

async function startLocalMCPServer() {
    // Create MCP server with default stdio transport
    const mcpServer = createDemosMCPServer()
    
    // Add all Demos Network tools
    const tools = createDemosNetworkTools()
    tools.forEach(tool => mcpServer.registerTool(tool))
    
    // Start the server
    await mcpServer.start()
    console.log("MCP server started successfully!")
    
    return mcpServer
}

// Start the server
startLocalMCPServer().catch(console.error)
```
{% endcode %}

### Remote Access Setup

For production deployments or remote access, use the SSE (Server-Sent Events) transport:

{% code title="Remote MCP Server Setup" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

async function startRemoteMCPServer() {
    // Create MCP server with SSE transport for remote access
    const mcpServer = createDemosMCPServer({
        transport: "sse",
        port: 3001,
        host: "0.0.0.0"  // Listen on all network interfaces
    })
    
    // Add Demos Network tools
    const tools = createDemosNetworkTools({
        enableBlockchainTools: true,
        enableNetworkTools: true,
        enablePeerTools: true
    })
    
    tools.forEach(tool => mcpServer.registerTool(tool))
    
    // Start the server
    await mcpServer.start()
    
    console.log("Remote MCP server started!")
    console.log("SSE endpoint: http://your-server-ip:3001/sse")
    console.log("Message endpoint: POST http://your-server-ip:3001/message")
    
    return mcpServer
}

startRemoteMCPServer().catch(console.error)
```
{% endcode %}

## Available Tools

The Demos Network MCP integration provides several categories of tools:

### Network Status Tools

Monitor the health and status of your Demos Network node:

{% code title="Network Status Example" overflow="wrap" lineNumbers="true" %}
```typescript
// Available network tools:
// - get_network_status: Get comprehensive network status
// - get_node_identity: Get node identity and public key info

// Example usage (through MCP client):
const networkStatus = await mcpClient.callTool("get_network_status", {})
console.log("Server port:", networkStatus.serverPort)
console.log("Connection string:", networkStatus.connectionString)
console.log("Last block:", networkStatus.lastBlockNumber)

const nodeIdentity = await mcpClient.callTool("get_node_identity", {})
console.log("Public key:", nodeIdentity.publicKey)
console.log("Public IP:", nodeIdentity.publicIP)
```
{% endcode %}

### Blockchain Query Tools

Access blockchain data and query block information:

{% code title="Blockchain Tools Example" overflow="wrap" lineNumbers="true" %}
```typescript
// Available blockchain tools:
// - get_last_block: Get the most recent block
// - get_block_by_number: Get a specific block by number
// - get_chain_height: Get current blockchain height

// Example usage (through MCP client):
const lastBlock = await mcpClient.callTool("get_last_block", {})
console.log("Latest block number:", lastBlock.number)
console.log("Block hash:", lastBlock.hash)

const specificBlock = await mcpClient.callTool("get_block_by_number", {
    blockNumber: 100
})
console.log("Block 100 details:", specificBlock)

const chainHeight = await mcpClient.callTool("get_chain_height", {})
console.log("Current chain height:", chainHeight.height)
```
{% endcode %}

### Peer Management Tools

Monitor and manage network peer connections:

{% code title="Peer Management Example" overflow="wrap" lineNumbers="true" %}
```typescript
// Available peer tools:
// - get_peer_list: Get detailed list of connected peers
// - get_peer_count: Get current number of connected peers

// Example usage (through MCP client):
const peerList = await mcpClient.callTool("get_peer_list", {})
console.log("Connected peers:", peerList.peerCount)
peerList.peers.forEach(peer => {
    console.log(`Peer: ${peer.identity} at ${peer.connectionString}`)
})

const peerCount = await mcpClient.callTool("get_peer_count", {})
console.log("Total peers:", peerCount.peerCount)
```
{% endcode %}

## Advanced Configuration

### Custom Server Configuration

Create a customized MCP server with specific capabilities:

{% code title="Custom Server Configuration" overflow="wrap" lineNumbers="true" %}
```typescript
import { MCPServerManager } from "@/features/mcp"

// Create server with custom configuration
const server = new MCPServerManager({
    name: "custom-demos-mcp",
    version: "2.0.0",
    description: "Custom Demos Network MCP Server",
    capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {}
    },
    transport: {
        type: "sse",
        port: 4001,
        host: "localhost"
    }
})

// Register custom tools
server.registerTool({
    name: "custom_blockchain_query",
    description: "Perform custom blockchain queries",
    inputSchema: z.object({
        query: z.string().describe("Custom query to execute"),
        parameters: z.record(z.any()).optional()
    }),
    handler: async (args) => {
        // Your custom logic here
        return {
            result: `Executed query: ${args.query}`,
            timestamp: new Date().toISOString()
        }
    }
})

await server.start()
```
{% endcode %}

### Production Deployment

Set up a production-ready MCP server with error handling and graceful shutdown:

{% code title="Production MCP Server" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

class ProductionMCPServer {
    private server: any = null
    
    async start() {
        try {
            // Use environment variables for configuration
            this.server = createDemosMCPServer({
                transport: "sse",
                port: parseInt(process.env.MCP_PORT || "3001"),
                host: process.env.MCP_HOST || "0.0.0.0"
            })
            
            // Add tools with error handling
            const tools = createDemosNetworkTools({
                enableBlockchainTools: process.env.ENABLE_BLOCKCHAIN !== "false",
                enableNetworkTools: process.env.ENABLE_NETWORK !== "false",
                enablePeerTools: process.env.ENABLE_PEERS !== "false"
            })
            
            tools.forEach(tool => this.server.registerTool(tool))
            
            // Start server
            await this.server.start()
            
            // Setup graceful shutdown
            this.setupGracefulShutdown()
            
            console.log("Production MCP server started successfully")
            console.log(`Listening on port: ${process.env.MCP_PORT || "3001"}`)
            
        } catch (error) {
            console.error("Failed to start production MCP server:", error)
            process.exit(1)
        }
    }
    
    private setupGracefulShutdown() {
        const shutdown = async (signal: string) => {
            console.log(`Received ${signal}, shutting down gracefully...`)
            
            if (this.server) {
                await this.server.shutdown()
                console.log("MCP server stopped")
            }
            
            process.exit(0)
        }
        
        process.on('SIGTERM', () => shutdown('SIGTERM'))
        process.on('SIGINT', () => shutdown('SIGINT'))
    }
}

// Start production server
const productionServer = new ProductionMCPServer()
productionServer.start()
```
{% endcode %}

## Integration with Demos Network Node

### Adding MCP to Main Node Process

Integrate the MCP server directly into your main Demos Network node:

{% code title="Node Integration" overflow="wrap" lineNumbers="true" %}
```typescript
// In your main node startup file (e.g., src/index.ts)
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

async function startDemosNodeWithMCP() {
    // ... existing node startup code ...
    
    // Start MCP server after node initialization
    const mcpServer = createDemosMCPServer({
        transport: process.env.MCP_REMOTE === "true" ? "sse" : "stdio",
        port: parseInt(process.env.MCP_PORT || "3001"),
        host: process.env.MCP_HOST || "localhost"
    })
    
    // Add all available tools
    const tools = createDemosNetworkTools()
    tools.forEach(tool => mcpServer.registerTool(tool))
    
    // Start MCP server
    await mcpServer.start()
    console.log("Demos Network node with MCP server started")
    
    // Store server reference for shutdown
    global.mcpServer = mcpServer
}

// Enhanced shutdown handling
process.on('SIGINT', async () => {
    console.log('Shutting down Demos Network node...')
    
    // Shutdown MCP server first
    if (global.mcpServer) {
        await global.mcpServer.shutdown()
    }
    
    // ... existing node shutdown code ...
    process.exit(0)
})

startDemosNodeWithMCP()
```
{% endcode %}

### Environment Configuration

Use environment variables for flexible deployment:

{% code title=".env Configuration" overflow="wrap" lineNumbers="true" %}
```bash
# MCP Server Configuration
MCP_REMOTE=true                    # Enable remote access
MCP_PORT=3001                      # Server port
MCP_HOST=0.0.0.0                   # Listen on all interfaces

# Tool Configuration
ENABLE_BLOCKCHAIN=true             # Enable blockchain tools
ENABLE_NETWORK=true                # Enable network tools
ENABLE_PEERS=true                  # Enable peer tools

# Security Configuration
MCP_CORS_ORIGIN=*                  # CORS allowed origins
MCP_MAX_CONNECTIONS=100            # Maximum concurrent connections
```
{% endcode %}

## Client Examples

### Using with Claude Desktop

Configure Claude Desktop to connect to your MCP server:

{% code title="Claude Desktop Configuration" overflow="wrap" lineNumbers="true" %}
```json
{
  "mcp_servers": {
    "demos-network": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```
{% endcode %}

### Custom MCP Client

Create a custom client to interact with the MCP server:

{% code title="Custom MCP Client" overflow="wrap" lineNumbers="true" %}
```typescript
// Example client for SSE transport
class DemosMCPClient {
    private eventSource: EventSource
    private baseUrl: string
    
    constructor(serverUrl: string) {
        this.baseUrl = serverUrl
        this.eventSource = new EventSource(`${serverUrl}/sse`)
        this.setupEventHandlers()
    }
    
    private setupEventHandlers() {
        this.eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data)
            console.log("Received from MCP server:", data)
        }
        
        this.eventSource.onerror = (error) => {
            console.error("SSE connection error:", error)
        }
    }
    
    async callTool(toolName: string, args: any = {}) {
        const response = await fetch(`${this.baseUrl}/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    name: toolName,
                    arguments: args
                },
                id: Date.now()
            })
        })
        
        return await response.json()
    }
    
    disconnect() {
        this.eventSource.close()
    }
}

// Usage
const client = new DemosMCPClient("http://localhost:3001")

// Call tools
const networkStatus = await client.callTool("get_network_status")
const lastBlock = await client.callTool("get_last_block")
const peers = await client.callTool("get_peer_list")

console.log("Network status:", networkStatus)
console.log("Last block:", lastBlock)
console.log("Peers:", peers)
```
{% endcode %}

## Security and Best Practices

### Network Security

{% code title="Security Configuration" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer } from "@/features/mcp"

// Secure production configuration
const secureServer = createDemosMCPServer({
    transport: "sse",
    port: 3001,
    host: "127.0.0.1"  // Only local connections for security
})

// Or for controlled remote access
const remoteServer = createDemosMCPServer({
    transport: "sse",
    port: 3001,
    host: "0.0.0.0",   // All interfaces, but use with firewall
})

// Add custom security middleware
server.expressApp?.use((req, res, next) => {
    // Add custom authentication
    const apiKey = req.headers['x-api-key']
    if (!apiKey || apiKey !== process.env.MCP_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
})
```
{% endcode %}

### Error Handling

{% code title="Robust Error Handling" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

async function startRobustMCPServer() {
    let server = null
    
    try {
        server = createDemosMCPServer({
            transport: "sse",
            port: 3001,
            host: "localhost"
        })
        
        // Add tools with individual error handling
        const tools = createDemosNetworkTools()
        
        for (const tool of tools) {
            try {
                server.registerTool(tool)
                console.log(`✓ Registered tool: ${tool.name}`)
            } catch (error) {
                console.error(`✗ Failed to register tool ${tool.name}:`, error)
                // Continue with other tools
            }
        }
        
        await server.start()
        console.log("MCP server started successfully")
        
        return server
        
    } catch (error) {
        console.error("Failed to start MCP server:", error)
        
        if (server) {
            try {
                await server.shutdown()
            } catch (shutdownError) {
                console.error("Error during shutdown:", shutdownError)
            }
        }
        
        throw error
    }
}

// Retry logic for production
async function startWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await startRobustMCPServer()
            break
        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error)
            
            if (attempt === maxRetries) {
                console.error("All retry attempts failed")
                process.exit(1)
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 5000))
        }
    }
}

startWithRetry()
```
{% endcode %}

## Monitoring and Debugging

### Server Status Monitoring

{% code title="MCP Server Monitoring" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer } from "@/features/mcp"

class MCPServerMonitor {
    private server: any
    private statusInterval: NodeJS.Timeout | null = null
    
    async start() {
        this.server = createDemosMCPServer({
            transport: "sse",
            port: 3001,
            host: "localhost"
        })
        
        // Add tools...
        await this.server.start()
        
        // Start monitoring
        this.startStatusMonitoring()
    }
    
    private startStatusMonitoring() {
        this.statusInterval = setInterval(() => {
            const status = this.server.getStatus()
            const tools = this.server.getRegisteredTools()
            
            console.log("=== MCP Server Status ===")
            console.log(`Running: ${status.isRunning}`)
            console.log(`Server: ${status.serverName} v${status.serverVersion}`)
            console.log(`Tools: ${status.toolCount} registered`)
            console.log(`Available tools: ${tools.join(', ')}`)
            console.log("========================")
        }, 30000) // Every 30 seconds
    }
    
    async stop() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval)
        }
        
        if (this.server) {
            await this.server.shutdown()
        }
    }
}

const monitor = new MCPServerMonitor()
monitor.start()
```
{% endcode %}

### Debug Logging

{% code title="Debug Configuration" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

// Enable debug mode
process.env.DEBUG = "true"

const server = createDemosMCPServer({
    transport: "sse",
    port: 3001,
    host: "localhost"
})

// Add tools with debug logging
const tools = createDemosNetworkTools()
tools.forEach(tool => {
    // Wrap tool handler with debug logging
    const originalHandler = tool.handler
    tool.handler = async (args) => {
        console.log(`[DEBUG] Calling tool: ${tool.name}`)
        console.log(`[DEBUG] Arguments:`, args)
        
        const startTime = Date.now()
        try {
            const result = await originalHandler(args)
            const duration = Date.now() - startTime
            
            console.log(`[DEBUG] Tool ${tool.name} completed in ${duration}ms`)
            console.log(`[DEBUG] Result:`, result)
            
            return result
        } catch (error) {
            console.error(`[DEBUG] Tool ${tool.name} failed:`, error)
            throw error
        }
    }
    
    server.registerTool(tool)
})

await server.start()
```
{% endcode %}

## Conclusion

The Demos Network MCP integration provides a powerful and flexible way to expose blockchain functionality to AI assistants and external applications. With support for both local and remote access, comprehensive tooling, and production-ready features, it enables seamless integration with the broader AI ecosystem while maintaining security and reliability.

For more detailed API documentation and advanced usage patterns, refer to the source code and examples in the `/src/features/mcp/` directory.