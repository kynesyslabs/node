# OmniProtocol - Step 8: TCP Server Implementation

**Status**: 🚧 CRITICAL - Required for Production
**Priority**: P0 - Blocks all network functionality
**Dependencies**: Steps 1-4, MessageFramer, Registry, Dispatcher

---

## 1. Overview

The current implementation is **client-only** - it can send TCP requests but cannot accept incoming connections. This document specifies the server-side TCP listener that accepts connections, authenticates peers, and dispatches messages to handlers.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    TCP Server Stack                       │
├──────────────────────────────────────────────────────────┤
│                                                            │
│   Node.js Net Server (Port 3001)                          │
│            ↓                                               │
│   ServerConnectionManager                                 │
│            ↓                                               │
│   InboundConnection (per client)                          │
│            ↓                                               │
│   MessageFramer (parse stream)                            │
│            ↓                                               │
│   AuthenticationMiddleware (validate)                     │
│            ↓                                               │
│   Dispatcher (route to handlers)                          │
│            ↓                                               │
│   Handler (business logic)                                │
│            ↓                                               │
│   Response Encoder                                        │
│            ↓                                               │
│   Socket.write() back to client                           │
│                                                            │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Core Components

### 2.1 OmniProtocolServer

**Purpose**: Main TCP server that listens for incoming connections

```typescript
import { Server as NetServer, Socket } from "net"
import { EventEmitter } from "events"
import { ServerConnectionManager } from "./ServerConnectionManager"
import { OmniProtocolConfig } from "../types/config"

export interface ServerConfig {
    host: string                    // Listen address (default: "0.0.0.0")
    port: number                    // Listen port (default: node.port + 1)
    maxConnections: number          // Max concurrent connections (default: 1000)
    connectionTimeout: number       // Idle connection timeout (default: 10 min)
    authTimeout: number             // Auth handshake timeout (default: 5 sec)
    backlog: number                 // TCP backlog queue (default: 511)
    enableKeepalive: boolean        // TCP keepalive (default: true)
    keepaliveInitialDelay: number   // Keepalive delay (default: 60 sec)
}

export class OmniProtocolServer extends EventEmitter {
    private server: NetServer | null = null
    private connectionManager: ServerConnectionManager
    private config: ServerConfig
    private isRunning: boolean = false

    constructor(config: Partial<ServerConfig> = {}) {
        super()

        this.config = {
            host: config.host ?? "0.0.0.0",
            port: config.port ?? this.detectNodePort() + 1,
            maxConnections: config.maxConnections ?? 1000,
            connectionTimeout: config.connectionTimeout ?? 10 * 60 * 1000,
            authTimeout: config.authTimeout ?? 5000,
            backlog: config.backlog ?? 511,
            enableKeepalive: config.enableKeepalive ?? true,
            keepaliveInitialDelay: config.keepaliveInitialDelay ?? 60000,
        }

        this.connectionManager = new ServerConnectionManager({
            maxConnections: this.config.maxConnections,
            connectionTimeout: this.config.connectionTimeout,
            authTimeout: this.config.authTimeout,
        })
    }

    /**
     * Start TCP server and begin accepting connections
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("Server is already running")
        }

        return new Promise((resolve, reject) => {
            this.server = new NetServer()

            // Configure server options
            this.server.maxConnections = this.config.maxConnections

            // Handle new connections
            this.server.on("connection", (socket: Socket) => {
                this.handleNewConnection(socket)
            })

            // Handle server errors
            this.server.on("error", (error: Error) => {
                this.emit("error", error)
                console.error("[OmniProtocolServer] Server error:", error)
            })

            // Handle server close
            this.server.on("close", () => {
                this.emit("close")
                console.log("[OmniProtocolServer] Server closed")
            })

            // Start listening
            this.server.listen(
                {
                    host: this.config.host,
                    port: this.config.port,
                    backlog: this.config.backlog,
                },
                () => {
                    this.isRunning = true
                    this.emit("listening", this.config.port)
                    console.log(
                        `[OmniProtocolServer] Listening on ${this.config.host}:${this.config.port}`
                    )
                    resolve()
                }
            )

            this.server.once("error", reject)
        })
    }

    /**
     * Stop server and close all connections
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        console.log("[OmniProtocolServer] Stopping server...")

        // Stop accepting new connections
        await new Promise<void>((resolve, reject) => {
            this.server?.close((err) => {
                if (err) reject(err)
                else resolve()
            })
        })

        // Close all existing connections
        await this.connectionManager.closeAll()

        this.isRunning = false
        this.server = null

        console.log("[OmniProtocolServer] Server stopped")
    }

    /**
     * Handle new incoming connection
     */
    private handleNewConnection(socket: Socket): void {
        const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`

        console.log(`[OmniProtocolServer] New connection from ${remoteAddress}`)

        // Check if we're at capacity
        if (this.connectionManager.getConnectionCount() >= this.config.maxConnections) {
            console.warn(
                `[OmniProtocolServer] Connection limit reached, rejecting ${remoteAddress}`
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "capacity")
            return
        }

        // Configure socket options
        if (this.config.enableKeepalive) {
            socket.setKeepAlive(true, this.config.keepaliveInitialDelay)
        }
        socket.setNoDelay(true) // Disable Nagle's algorithm for low latency

        // Hand off to connection manager
        try {
            this.connectionManager.handleConnection(socket)
            this.emit("connection_accepted", remoteAddress)
        } catch (error) {
            console.error(
                `[OmniProtocolServer] Failed to handle connection from ${remoteAddress}:`,
                error
            )
            socket.destroy()
            this.emit("connection_rejected", remoteAddress, "error")
        }
    }

    /**
     * Get server statistics
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            port: this.config.port,
            connections: this.connectionManager.getStats(),
        }
    }

    /**
     * Detect node's HTTP port from environment/config
     */
    private detectNodePort(): number {
        // Try to read from environment or config
        const httpPort = parseInt(process.env.NODE_PORT || "3000")
        return httpPort
    }
}
```

### 2.2 ServerConnectionManager

**Purpose**: Manages lifecycle of all inbound connections

```typescript
import { Socket } from "net"
import { InboundConnection } from "./InboundConnection"
import { EventEmitter } from "events"

export interface ConnectionManagerConfig {
    maxConnections: number
    connectionTimeout: number
    authTimeout: number
}

export class ServerConnectionManager extends EventEmitter {
    private connections: Map<string, InboundConnection> = new Map()
    private config: ConnectionManagerConfig
    private cleanupTimer: NodeJS.Timeout | null = null

    constructor(config: ConnectionManagerConfig) {
        super()
        this.config = config
        this.startCleanupTimer()
    }

    /**
     * Handle new incoming socket connection
     */
    handleConnection(socket: Socket): void {
        const connectionId = this.generateConnectionId(socket)

        // Create inbound connection wrapper
        const connection = new InboundConnection(socket, connectionId, {
            authTimeout: this.config.authTimeout,
            connectionTimeout: this.config.connectionTimeout,
        })

        // Track connection
        this.connections.set(connectionId, connection)

        // Handle connection lifecycle events
        connection.on("authenticated", (peerIdentity: string) => {
            this.emit("peer_authenticated", peerIdentity, connectionId)
        })

        connection.on("error", (error: Error) => {
            this.emit("connection_error", connectionId, error)
            this.removeConnection(connectionId)
        })

        connection.on("close", () => {
            this.removeConnection(connectionId)
        })

        // Start connection (will wait for hello_peer)
        connection.start()
    }

    /**
     * Close all connections
     */
    async closeAll(): Promise<void> {
        console.log(`[ServerConnectionManager] Closing ${this.connections.size} connections...`)

        const closePromises = Array.from(this.connections.values()).map(conn =>
            conn.close()
        )

        await Promise.allSettled(closePromises)

        this.connections.clear()

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }

    /**
     * Get connection count
     */
    getConnectionCount(): number {
        return this.connections.size
    }

    /**
     * Get statistics
     */
    getStats() {
        let authenticated = 0
        let pending = 0
        let idle = 0

        for (const conn of this.connections.values()) {
            const state = conn.getState()
            if (state === "AUTHENTICATED") authenticated++
            else if (state === "PENDING_AUTH") pending++
            else if (state === "IDLE") idle++
        }

        return {
            total: this.connections.size,
            authenticated,
            pending,
            idle,
        }
    }

    /**
     * Remove connection from tracking
     */
    private removeConnection(connectionId: string): void {
        const removed = this.connections.delete(connectionId)
        if (removed) {
            this.emit("connection_removed", connectionId)
        }
    }

    /**
     * Generate unique connection identifier
     */
    private generateConnectionId(socket: Socket): string {
        return `${socket.remoteAddress}:${socket.remotePort}:${Date.now()}`
    }

    /**
     * Periodic cleanup of dead/idle connections
     */
    private startCleanupTimer(): void {
        this.cleanupTimer = setInterval(() => {
            const now = Date.now()
            const toRemove: string[] = []

            for (const [id, conn] of this.connections) {
                const state = conn.getState()
                const lastActivity = conn.getLastActivity()

                // Remove closed connections
                if (state === "CLOSED") {
                    toRemove.push(id)
                    continue
                }

                // Remove idle connections
                if (state === "IDLE" && now - lastActivity > this.config.connectionTimeout) {
                    toRemove.push(id)
                    conn.close()
                    continue
                }

                // Remove pending auth connections that timed out
                if (
                    state === "PENDING_AUTH" &&
                    now - conn.getCreatedAt() > this.config.authTimeout
                ) {
                    toRemove.push(id)
                    conn.close()
                    continue
                }
            }

            for (const id of toRemove) {
                this.removeConnection(id)
            }

            if (toRemove.length > 0) {
                console.log(
                    `[ServerConnectionManager] Cleaned up ${toRemove.length} connections`
                )
            }
        }, 60000) // Run every minute
    }
}
```

### 2.3 InboundConnection

**Purpose**: Handles a single inbound connection from a peer

```typescript
import { Socket } from "net"
import { EventEmitter } from "events"
import { MessageFramer } from "../transport/MessageFramer"
import { dispatchOmniMessage } from "../protocol/dispatcher"
import { OmniMessageHeader, ParsedOmniMessage } from "../types/message"
import { verifyAuthBlock } from "../auth/verifier"

export type ConnectionState =
    | "PENDING_AUTH"      // Waiting for hello_peer
    | "AUTHENTICATED"     // hello_peer succeeded
    | "IDLE"              // No activity
    | "CLOSING"           // Graceful shutdown
    | "CLOSED"            // Fully closed

export interface InboundConnectionConfig {
    authTimeout: number
    connectionTimeout: number
}

export class InboundConnection extends EventEmitter {
    private socket: Socket
    private connectionId: string
    private framer: MessageFramer
    private state: ConnectionState = "PENDING_AUTH"
    private config: InboundConnectionConfig

    private peerIdentity: string | null = null
    private createdAt: number = Date.now()
    private lastActivity: number = Date.now()
    private authTimer: NodeJS.Timeout | null = null

    constructor(
        socket: Socket,
        connectionId: string,
        config: InboundConnectionConfig
    ) {
        super()
        this.socket = socket
        this.connectionId = connectionId
        this.config = config
        this.framer = new MessageFramer()
    }

    /**
     * Start handling connection
     */
    start(): void {
        console.log(`[InboundConnection] ${this.connectionId} starting`)

        // Setup socket handlers
        this.socket.on("data", (chunk: Buffer) => {
            this.handleIncomingData(chunk)
        })

        this.socket.on("error", (error: Error) => {
            console.error(`[InboundConnection] ${this.connectionId} error:`, error)
            this.emit("error", error)
            this.close()
        })

        this.socket.on("close", () => {
            console.log(`[InboundConnection] ${this.connectionId} socket closed`)
            this.state = "CLOSED"
            this.emit("close")
        })

        // Start authentication timeout
        this.authTimer = setTimeout(() => {
            if (this.state === "PENDING_AUTH") {
                console.warn(
                    `[InboundConnection] ${this.connectionId} authentication timeout`
                )
                this.close()
            }
        }, this.config.authTimeout)
    }

    /**
     * Handle incoming TCP data
     */
    private async handleIncomingData(chunk: Buffer): Promise<void> {
        this.lastActivity = Date.now()

        // Add to framer
        this.framer.addData(chunk)

        // Extract all complete messages
        let message = this.framer.extractMessage()
        while (message) {
            await this.handleMessage(message.header, message.payload)
            message = this.framer.extractMessage()
        }
    }

    /**
     * Handle a complete decoded message
     */
    private async handleMessage(
        header: OmniMessageHeader,
        payload: Buffer
    ): Promise<void> {
        console.log(
            `[InboundConnection] ${this.connectionId} received opcode 0x${header.opcode.toString(16)}`
        )

        try {
            // Build parsed message
            const parsedMessage: ParsedOmniMessage = {
                header,
                payload,
                auth: null, // Will be populated by auth middleware if present
            }

            // Dispatch to handler
            const responsePayload = await dispatchOmniMessage({
                message: parsedMessage,
                context: {
                    peerIdentity: this.peerIdentity || "unknown",
                    connectionId: this.connectionId,
                    remoteAddress: this.socket.remoteAddress || "unknown",
                    isAuthenticated: this.state === "AUTHENTICATED",
                },
                fallbackToHttp: async () => {
                    throw new Error("HTTP fallback not available on server side")
                },
            })

            // Send response back to client
            await this.sendResponse(header.sequence, responsePayload)

            // If this was hello_peer and succeeded, mark as authenticated
            if (header.opcode === 0x01 && this.state === "PENDING_AUTH") {
                // Extract peer identity from response
                // TODO: Parse hello_peer response to get peer identity
                this.peerIdentity = "peer_identity_from_hello" // Placeholder
                this.state = "AUTHENTICATED"

                if (this.authTimer) {
                    clearTimeout(this.authTimer)
                    this.authTimer = null
                }

                this.emit("authenticated", this.peerIdentity)
                console.log(
                    `[InboundConnection] ${this.connectionId} authenticated as ${this.peerIdentity}`
                )
            }
        } catch (error) {
            console.error(
                `[InboundConnection] ${this.connectionId} handler error:`,
                error
            )

            // Send error response
            const errorPayload = Buffer.from(
                JSON.stringify({
                    error: String(error),
                })
            )
            await this.sendResponse(header.sequence, errorPayload)
        }
    }

    /**
     * Send response message back to client
     */
    private async sendResponse(sequence: number, payload: Buffer): Promise<void> {
        const header: OmniMessageHeader = {
            version: 1,
            opcode: 0xff, // Response opcode (use same as request ideally)
            sequence,
            payloadLength: payload.length,
        }

        const messageBuffer = MessageFramer.encodeMessage(header, payload)

        return new Promise((resolve, reject) => {
            this.socket.write(messageBuffer, (error) => {
                if (error) {
                    console.error(
                        `[InboundConnection] ${this.connectionId} write error:`,
                        error
                    )
                    reject(error)
                } else {
                    resolve()
                }
            })
        })
    }

    /**
     * Close connection gracefully
     */
    async close(): Promise<void> {
        if (this.state === "CLOSED" || this.state === "CLOSING") {
            return
        }

        this.state = "CLOSING"

        if (this.authTimer) {
            clearTimeout(this.authTimer)
            this.authTimer = null
        }

        return new Promise((resolve) => {
            this.socket.once("close", () => {
                this.state = "CLOSED"
                resolve()
            })
            this.socket.end()
        })
    }

    getState(): ConnectionState {
        return this.state
    }

    getLastActivity(): number {
        return this.lastActivity
    }

    getCreatedAt(): number {
        return this.createdAt
    }

    getPeerIdentity(): string | null {
        return this.peerIdentity
    }
}
```

---

## 3. Integration Points

### 3.1 Node Startup

Add server initialization to node startup sequence:

```typescript
// src/index.ts or main entry point

import { OmniProtocolServer } from "./libs/omniprotocol/server/OmniProtocolServer"

class DemosNode {
    private omniServer: OmniProtocolServer | null = null

    async start() {
        // ... existing startup code ...

        // Start OmniProtocol TCP server
        if (config.omniprotocol.enabled) {
            this.omniServer = new OmniProtocolServer({
                host: config.omniprotocol.host || "0.0.0.0",
                port: config.omniprotocol.port || config.node.port + 1,
                maxConnections: config.omniprotocol.maxConnections || 1000,
            })

            this.omniServer.on("listening", (port) => {
                console.log(`✅ OmniProtocol server listening on port ${port}`)
            })

            this.omniServer.on("error", (error) => {
                console.error("❌ OmniProtocol server error:", error)
            })

            await this.omniServer.start()
        }

        // ... existing startup code ...
    }

    async stop() {
        // Stop OmniProtocol server
        if (this.omniServer) {
            await this.omniServer.stop()
        }

        // ... existing shutdown code ...
    }
}
```

### 3.2 Configuration

Add server config to node configuration:

```typescript
// config.ts or equivalent

export interface NodeConfig {
    // ... existing config ...

    omniprotocol: {
        enabled: boolean                // Enable OmniProtocol server
        host: string                    // Listen address
        port: number                    // Listen port (default: node.port + 1)
        maxConnections: number          // Max concurrent connections
        authTimeout: number             // Auth handshake timeout (ms)
        connectionTimeout: number       // Idle connection timeout (ms)
    }
}

export const defaultConfig: NodeConfig = {
    // ... existing defaults ...

    omniprotocol: {
        enabled: true,
        host: "0.0.0.0",
        port: 3001, // Will be node.port + 1
        maxConnections: 1000,
        authTimeout: 5000,
        connectionTimeout: 600000, // 10 minutes
    }
}
```

---

## 4. Handler Integration

Handlers are already implemented and registered in `registry.ts`. The server dispatcher will route messages to them automatically:

```typescript
// Dispatcher flow (already implemented in dispatcher.ts)
export async function dispatchOmniMessage(
    options: DispatchOptions
): Promise<Buffer> {
    const opcode = options.message.header.opcode as OmniOpcode
    const descriptor = getHandler(opcode)

    if (!descriptor) {
        throw new UnknownOpcodeError(opcode)
    }

    // Call handler (e.g., handleProposeBlockHash, handleExecute, etc.)
    return await descriptor.handler({
        message: options.message,
        context: options.context,
        fallbackToHttp: options.fallbackToHttp,
    })
}
```

---

## 5. Security Considerations

### 5.1 Rate Limiting

```typescript
class RateLimiter {
    private requests: Map<string, number[]> = new Map()
    private readonly windowMs = 60000 // 1 minute
    private readonly maxRequests = 100

    isAllowed(identifier: string): boolean {
        const now = Date.now()
        const requests = this.requests.get(identifier) || []

        // Remove old requests outside window
        const recent = requests.filter(time => now - time < this.windowMs)

        if (recent.length >= this.maxRequests) {
            return false
        }

        recent.push(now)
        this.requests.set(identifier, recent)
        return true
    }
}
```

### 5.2 Connection Limits Per IP

```typescript
class ConnectionLimiter {
    private connectionsPerIp: Map<string, number> = new Map()
    private readonly maxPerIp = 10

    canAccept(ip: string): boolean {
        const current = this.connectionsPerIp.get(ip) || 0
        return current < this.maxPerIp
    }

    increment(ip: string): void {
        const current = this.connectionsPerIp.get(ip) || 0
        this.connectionsPerIp.set(ip, current + 1)
    }

    decrement(ip: string): void {
        const current = this.connectionsPerIp.get(ip) || 0
        this.connectionsPerIp.set(ip, Math.max(0, current - 1))
    }
}
```

---

## 6. Testing

### 6.1 Unit Tests

```typescript
describe("OmniProtocolServer", () => {
    it("should start and listen on specified port", async () => {
        const server = new OmniProtocolServer({ port: 9999 })
        await server.start()

        const stats = server.getStats()
        expect(stats.isRunning).toBe(true)
        expect(stats.port).toBe(9999)

        await server.stop()
    })

    it("should accept incoming connections", async () => {
        const server = new OmniProtocolServer({ port: 9998 })
        await server.start()

        // Connect with client
        const client = net.connect({ port: 9998 })

        await new Promise(resolve => {
            server.once("connection_accepted", resolve)
        })

        client.destroy()
        await server.stop()
    })

    it("should reject connections at capacity", async () => {
        const server = new OmniProtocolServer({
            port: 9997,
            maxConnections: 1
        })
        await server.start()

        // Connect first client
        const client1 = net.connect({ port: 9997 })
        await new Promise(resolve => server.once("connection_accepted", resolve))

        // Try second client (should be rejected)
        const client2 = net.connect({ port: 9997 })
        await new Promise(resolve => server.once("connection_rejected", resolve))

        client1.destroy()
        client2.destroy()
        await server.stop()
    })
})
```

---

## 7. Implementation Checklist

- [ ] **OmniProtocolServer class** (main TCP listener)
- [ ] **ServerConnectionManager class** (connection lifecycle)
- [ ] **InboundConnection class** (per-connection handler)
- [ ] **Rate limiting** (per-IP and per-peer)
- [ ] **Connection limits** (total and per-IP)
- [ ] **Integration with node startup** (start/stop lifecycle)
- [ ] **Configuration** (enable/disable, ports, limits)
- [ ] **Error handling** (socket errors, timeouts, protocol errors)
- [ ] **Metrics/logging** (connection stats, throughput, errors)
- [ ] **Unit tests** (server startup, connection handling, limits)
- [ ] **Integration tests** (full client-server roundtrip)
- [ ] **Load tests** (1000+ concurrent connections)

---

## 8. Deployment Notes

### Port Configuration

- **Default**: Node HTTP port + 1 (e.g., 3000 → 3001)
- **Firewall**: Ensure TCP port is open for incoming connections
- **Load Balancer**: If using LB, ensure it supports TCP passthrough

### Monitoring

Monitor these metrics:
- Active connections count
- Connections per second (new/closed)
- Authentication success/failure rate
- Handler latency (p50, p95, p99)
- Error rate by type
- Memory usage (connection buffers)

### Resource Limits

Adjust system limits for production:
```bash
# Increase file descriptor limit
ulimit -n 65536

# TCP tuning
sysctl -w net.core.somaxconn=4096
sysctl -w net.ipv4.tcp_max_syn_backlog=8192
```

---

## Summary

This specification provides a complete TCP server implementation to complement the existing client-side code. Once implemented, nodes will be able to:

✅ Accept incoming OmniProtocol connections
✅ Authenticate peers via hello_peer handshake
✅ Dispatch messages to registered handlers
✅ Send responses back to clients
✅ Handle thousands of concurrent connections
✅ Enforce rate limits and connection limits
✅ Monitor server health and performance

**Next**: Implement Authentication Block parsing and validation (09_AUTHENTICATION_IMPLEMENTATION.md)
