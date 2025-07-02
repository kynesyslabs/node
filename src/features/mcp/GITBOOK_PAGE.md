# MCP Integration in Demos Network Node

The Model Context Protocol (MCP) integration is automatically enabled in Demos Network nodes, providing AI assistants and external applications with standardized access to blockchain data, network monitoring, and peer management capabilities.

## Overview

MCP (Model Context Protocol) is an open standard that allows AI assistants to connect to external data sources and tools. The Demos Network node automatically starts an MCP server that provides:

- **Dual Transport Support**: stdio for local applications, SSE for remote network access
- **Comprehensive Tools**: blockchain queries, network monitoring, and peer management
- **Production Ready**: Full error handling, logging, and security considerations
- **Type Safe**: Complete TypeScript support with runtime validation
- **Automatic Integration**: Started automatically with your Demos Network node

## How It Works in the Node

### Automatic Startup

The MCP server is automatically started when you run your Demos Network node (`src/index.ts`). The integration follows these steps:

1. **Environment Configuration**: Loads MCP settings from environment variables
2. **Port Management**: Automatically selects available ports using the same system as other services
3. **Failsafe Design**: Node continues running even if MCP server fails to start
4. **State Tracking**: MCP server status is tracked in shared state for monitoring

### Configuration

The MCP server is configured through environment variables in your `.env` file:

{% code title="Environment Configuration" overflow="wrap" lineNumbers="true" %}
```bash
# MCP Server Configuration
MCP_ENABLED=true              # Enable/disable MCP server (default: true)
MCP_SERVER_PORT=3001          # Preferred port for MCP server (default: 3001)
# Alternative port override
RPC_MCP_PORT=3001             # Alternative way to set MCP port
```
{% endcode %}

### Integration Architecture

The MCP server is integrated into the main node process following the same patterns as the signaling server:

{% code title="Node Integration Pattern" overflow="wrap" lineNumbers="true" %}
```typescript
// From src/index.ts - MCP server startup
if (indexState.MCP_ENABLED) {
    try {
        const { createDemosMCPServer, createDemosNetworkTools } = await import("./features/mcp")
        
        // Get available port
        indexState.MCP_SERVER_PORT = await getNextAvailablePort(indexState.MCP_SERVER_PORT)
        
        // Create server with SSE transport for remote access
        const mcpServer = createDemosMCPServer({
            transport: "sse",
            port: indexState.MCP_SERVER_PORT,
            host: "localhost"
        })
        
        // Add all Demos Network tools
        const tools = createDemosNetworkTools()
        tools.forEach(tool => mcpServer.registerTool(tool))
        
        await mcpServer.start()
        
        // Track in state
        indexState.mcpServer = mcpServer
        getSharedState.isMCPServerStarted = true
        console.log(`[MAIN] MCP server started on port ${indexState.MCP_SERVER_PORT}`)
    } catch (error) {
        console.log("[MAIN] Failed to start MCP server:", error)
        getSharedState.isMCPServerStarted = false
        // Continue without MCP (failsafe)
    }
}
```
{% endcode %}

## Monitoring MCP Server Status

### Status Endpoint

The node provides a dedicated `/mcp` endpoint to check MCP server status:

{% code title="MCP Status Endpoint" overflow="wrap" lineNumbers="true" %}
```bash
# Check MCP server status
curl http://localhost:53550/mcp

# Example response:
{
  "enabled": true,
  "transport": "sse",
  "status": "running"
}
```
{% endcode %}

### Available Tools

The MCP server automatically provides these tools when started with your node:

#### Network Status Tools

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

#### Blockchain Query Tools

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

#### Peer Management Tools

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

## Connecting to the MCP Server

### Remote Access (SSE Transport)

The node starts the MCP server with SSE transport by default, making it accessible remotely:

{% code title="MCP Server Connection" overflow="wrap" lineNumbers="true" %}
```typescript
// Connect to your running Demos Network node's MCP server
const serverUrl = "http://localhost:3001"  // Use your node's MCP port

// For SSE (remote) connections:
// SSE endpoint: http://localhost:3001/sse
// Message endpoint: POST http://localhost:3001/message
```
{% endcode %}

### Local Access (stdio Transport)

For local development, you can also create a separate stdio MCP server:

{% code title="Local MCP Development" overflow="wrap" lineNumbers="true" %}
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

// Create a separate stdio server for development
const devServer = createDemosMCPServer({
    transport: "stdio"  // For local development tools
})

const tools = createDemosNetworkTools()
tools.forEach(tool => devServer.registerTool(tool))

await devServer.start()
```
{% endcode %}

## Advanced Configuration

### Custom Tool Selection

You can customize which tools are available if needed:

{% code title="Custom Tool Configuration" overflow="wrap" lineNumbers="true" %}
```typescript
// In a custom implementation, you can select specific tools
const tools = createDemosNetworkTools({
    enableBlockchainTools: true,
    enableNetworkTools: true,
    enablePeerTools: false  // Disable peer tools if not needed
})
```
{% endcode %}

## Client Examples

### Using with Claude Desktop

Configure Claude Desktop to connect to your Demos Network node's MCP server:

{% code title="Claude Desktop Configuration (SSE)" overflow="wrap" lineNumbers="true" %}
```json
{
  "mcp_servers": {
    "demos-network": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/cli", "sse", "http://localhost:3001/sse"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```
{% endcode %}

Or for local stdio connection to a running node:

{% code title="Claude Desktop Configuration (stdio)" overflow="wrap" lineNumbers="true" %}
```json
{
  "mcp_servers": {
    "demos-network": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "MCP_ENABLED": "true",
        "NODE_ENV": "production"
      }
    }
  }
}
```
{% endcode %}

### Custom MCP Client

Create a custom client to interact with your running node's MCP server:

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

## Troubleshooting

### Common Issues

**MCP Server Not Starting**
- Check if port 3001 is available or change `MCP_SERVER_PORT` in your environment
- Verify `MCP_ENABLED=true` in your `.env` file
- Check node logs for MCP startup errors

**Can't Connect to MCP Server**
- Verify the node is running and MCP server started successfully
- Check the `/mcp` status endpoint: `curl http://localhost:53550/mcp`
- Ensure firewall allows connections to the MCP port

**Tools Not Working**
- Verify the node is fully synced and operational
- Check that blockchain data is accessible
- Review MCP server logs for tool execution errors

### Debug Mode

Enable debug logging for MCP operations:

{% code title="Debug Configuration" overflow="wrap" lineNumbers="true" %}
```bash
# Add to your .env file
DEBUG=mcp:*
MCP_LOG_LEVEL=debug
```
{% endcode %}

## Conclusion

The MCP integration is automatically available in every Demos Network node, providing seamless access to blockchain data and network information for AI assistants and external applications. The failsafe design ensures your node continues operating even if MCP encounters issues, while the comprehensive tooling enables powerful AI-driven blockchain interactions.

For detailed API documentation and tool specifications, refer to the implementation in `/src/features/mcp/`.