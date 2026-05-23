# MCP (Model Context Protocol) Integration for Demos Network

> **⚠️ SECURITY: experimental — no built-in authentication.**
> The MCP server is **disabled by default** since Epic 14 (2026-05-14).
> Its `get_node_identity` and `get_peer_list` tools leak the node's
> public key and peer topology to any reachable client.
> **Do not bind `0.0.0.0` or publish the port via docker-compose** until
> an authenticated reverse proxy (Caddy bearer-auth, mTLS, or equivalent)
> is in front. Older examples in this README that show
> `"0.0.0.0"` as a host or suggest "external access" predate that policy
> and apply only behind such a proxy.
>
> See `docs/runbooks/mcp-security.md` for the threat model and the
> recommended enablement path. Enable with `MCP_ENABLED=true` only after
> reading it.

This module provides comprehensive MCP server functionality for the Demos Network, enabling AI assistants and other clients to interact with blockchain operations, network status, and node management through a standardized protocol.

## Overview

The MCP integration consists of:
- **MCPServerManager**: Core server management class with dual transport support
- **Demos Network Tools**: Pre-built tools for blockchain and network operations  
- **Transport Options**: Both stdio (local) and SSE (remote network) support
- **Examples**: Sample implementations for quick setup

## Features

- ✅ **Dual Transport Support**: stdio for local clients, SSE for remote access
- ✅ **Blockchain Tools**: Query blocks, transactions, and chain status
- ✅ **Network Monitoring**: Get node status, identity, and network information
- ✅ **Peer Management**: List and monitor connected peers
- ✅ **Full MCP Compliance**: Works with any MCP-compatible client
- ✅ **TypeScript Support**: Full type safety and IntelliSense
- ✅ **Comprehensive Logging**: Detailed operation logging and error handling

## Quick Start

### Local MCP Server (stdio transport)
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

// Create and configure MCP server with stdio transport (default)
const mcpServer = createDemosMCPServer({ transport: "stdio" })

// Add Demos Network tools
const tools = createDemosNetworkTools()
tools.forEach(tool => mcpServer.registerTool(tool))

// Start the server
await mcpServer.start()
```

### Remote MCP Server (SSE transport)
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

// Create MCP server with SSE transport for remote access
const mcpServer = createDemosMCPServer({
    transport: "sse",
    port: 3001,
    host: "0.0.0.0"  // Listen on all interfaces
})

// Add Demos Network tools
const tools = createDemosNetworkTools()
tools.forEach(tool => mcpServer.registerTool(tool))

// Start the server
await mcpServer.start()

// Remote clients can now connect to:
// - SSE endpoint: http://your-ip:3001/sse
// - Message endpoint: POST http://your-ip:3001/message
```

## Available Tools

### Network Tools
- **`get_network_status`**: Get current network status including server port, connection string, and basic node info
- **`get_node_identity`**: Get node identity and public key information

### Blockchain Tools
- **`get_last_block`**: Get information about the latest block in the chain
- **`get_block_by_number`**: Retrieve a specific block by its number
- **`get_chain_height`**: Get current blockchain height (number of blocks)

### Peer Tools
- **`get_peer_list`**: Get list of connected peers with connection details
- **`get_peer_count`**: Get the current number of connected peers

## Architecture

### MCPServerManager
The main server class that handles:
- **Server lifecycle**: Start, stop, and graceful shutdown
- **Tool registration**: Dynamic tool management and validation
- **Transport management**: Handle both stdio and SSE connections
- **Error handling**: Comprehensive error handling and logging
- **Multi-client support**: Handle multiple simultaneous connections (SSE mode)

### Transport System
- **Stdio Transport**: Standard input/output for local process communication
- **SSE Transport**: Server-Sent Events over HTTP for remote network access
- **Automatic Selection**: Choose transport based on configuration
- **Protocol Compliance**: Full MCP protocol support on both transports

### Tool System
Each tool consists of:
- **Name and description**: Human-readable identification
- **Input schema validation**: Zod-based type-safe input validation
- **Handler function**: Async execution with error handling
- **Result formatting**: Consistent JSON response formatting

## Configuration

### Server Configuration
```typescript
interface MCPServerConfig {
    name: string                              // Server identification name
    version: string                           // Server version
    description?: string                      // Optional description
    capabilities?: Partial<ServerCapabilities>  // MCP capabilities
    transport?: {
        type: "stdio" | "sse"                // Transport type
        port?: number                         // Port for SSE transport
        host?: string                         // Host for SSE transport
    }
}
```

### Tools Configuration
```typescript
interface DemosNetworkToolsConfig {
    enableBlockchainTools?: boolean          // Enable blockchain tools (default: true)
    enableNetworkTools?: boolean             // Enable network tools (default: true)
    enablePeerTools?: boolean                // Enable peer tools (default: true)
}
```

## Integration Patterns

### Basic Integration
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

export async function startMCPServer() {
    const server = createDemosMCPServer()
    const tools = createDemosNetworkTools()
    
    tools.forEach(tool => server.registerTool(tool))
    await server.start()
    
    return server
}
```

### Custom Tool Integration
```typescript
import { MCPServerManager, createDemosNetworkTools } from "@/features/mcp"
import { z } from "zod"

const server = new MCPServerManager({
    name: "custom-demos-server",
    version: "1.0.0"
})

// Add custom tool
server.registerTool({
    name: "custom_operation",
    description: "Perform a custom operation",
    inputSchema: z.object({
        operation: z.string().describe("Operation to perform")
    }),
    handler: async (args) => {
        // Custom logic here
        return { result: `Performed: ${args.operation}` }
    }
})

// Add standard Demos tools
const demosTools = createDemosNetworkTools()
demosTools.forEach(tool => server.registerTool(tool))
```

### Production Setup with Error Handling
```typescript
import { createDemosMCPServer, createDemosNetworkTools } from "@/features/mcp"

export async function setupProductionMCPServer() {
    try {
        const server = createDemosMCPServer({
            transport: "sse",
            port: process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 3001,
            host: process.env.MCP_HOST || "0.0.0.0"
        })

        const tools = createDemosNetworkTools({
            enableBlockchainTools: true,
            enableNetworkTools: true,
            enablePeerTools: true
        })

        tools.forEach(tool => server.registerTool(tool))
        await server.start()

        // Graceful shutdown handling
        process.on('SIGINT', async () => {
            console.log('Shutting down MCP server...')
            await server.shutdown()
            process.exit(0)
        })

        return server
    } catch (error) {
        console.error('Failed to start MCP server:', error)
        throw error
    }
}
```

## Error Handling

The MCP server includes comprehensive error handling:
- **Input validation**: Zod schema validation for all tool inputs
- **Operation errors**: Proper error logging with context and stack traces
- **Transport errors**: Connection failure handling and recovery
- **Graceful degradation**: Continued operation despite individual tool failures
- **Client-friendly errors**: Clear, actionable error messages for debugging

## Security Considerations

### Network Security (SSE Transport)
- **CORS enabled**: Allows cross-origin requests for web clients
- **Input validation**: All inputs validated before processing
- **Error isolation**: Tool errors don't crash the entire server
- **Resource limits**: Built-in timeouts and resource management

### Access Control
- **Network binding**: Configure host binding for security (localhost vs 0.0.0.0)
- **Port configuration**: Use non-standard ports to avoid conflicts
- **Connection logging**: All connections and operations are logged

## Examples

See the `examples/` directory for:
- **`simpleExample.ts`**: Basic server setup with configurable transport
- **`remoteExample.ts`**: Remote access setup with detailed configuration

## Dependencies

- **`@modelcontextprotocol/sdk`**: Core MCP SDK for protocol implementation
- **`express`**: HTTP server for SSE transport
- **`cors`**: Cross-origin resource sharing support
- **`zod`**: Runtime type validation for inputs
- **Demos Network utilities**: Blockchain, networking, and peer management modules

## Troubleshooting

### Common Issues

**Server won't start (SSE mode)**
- Check if port is already in use
- Verify host binding configuration
- Check firewall rules for the specified port

**Tools not responding**
- Verify Demos Network node is running and initialized
- Check shared state initialization
- Review tool registration logs

**Remote clients can't connect**
- Ensure host is set to "0.0.0.0" for external access
- Check network firewall rules
- Verify SSE endpoint accessibility

### Debug Mode
Enable detailed logging by setting log level:
```typescript
// Add more detailed logging
console.log(server.getStatus())
console.log(server.getRegisteredTools())
```

## Contributing

When adding new tools:
1. **Follow naming conventions**: Use descriptive, action-based names
2. **Add comprehensive validation**: Use Zod schemas for input validation
3. **Include JSDoc documentation**: Document parameters, returns, and examples
4. **Handle errors gracefully**: Provide meaningful error messages
5. **Add to appropriate category**: Group related tools together
6. **Test thoroughly**: Verify tools work with both transport types

## API Reference

For detailed API documentation, see the JSDoc comments in the source files:
- `MCPServer.ts`: Core server functionality
- `tools/demosTools.ts`: Available tools and their schemas
- `examples/`: Usage patterns and integration examples