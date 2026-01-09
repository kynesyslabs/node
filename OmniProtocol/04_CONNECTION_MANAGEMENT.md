# OmniProtocol - Step 4: Connection Management & Lifecycle

## Design Philosophy

This step defines TCP connection pooling, resource management, and concurrency patterns for OmniProtocol. All designs maintain existing HTTP-based semantics while leveraging TCP's persistent connection advantages.

### Current HTTP Patterns (Reference)

**From Peer.ts analysis:**
- `call()`: 3 second timeout, single request-response
- `longCall()`: 3 retries, configurable sleep (typically 250ms-1000ms)
- `multiCall()`: Parallel Promise.all, 2 second timeout
- Stateless HTTP with axios (no connection reuse)

**OmniProtocol Goals:**
- Maintain same timeout semantics
- Preserve retry behavior
- Support parallel operations
- Add connection pooling efficiency
- Handle thousands of concurrent peers

## 1. Connection Pool Architecture

### Pool Design: Per-Peer Connection

**Pattern**: One TCP connection per peer identity (not per-call)

```typescript
class ConnectionPool {
    // Map: peer identity → TCP connection
    private connections: Map<string, PeerConnection> = new Map()

    // Pool configuration
    private config = {
        maxConnectionsPerPeer: 1,      // Single connection per peer
        idleTimeout: 10 * 60 * 1000,   // 10 minutes
        connectTimeout: 5000,           // 5 seconds
        maxConcurrentRequests: 100,     // Per connection
    }
}
```

**Rationale:**
- HTTP is stateless: new TCP connection per request (expensive)
- OmniProtocol is stateful: reuse TCP connection across requests (efficient)
- One connection per peer sufficient (requests are sequential per peer in current design)
- Can scale to multiple connections per peer later if needed

### Connection States (Detailed)

```
┌─────────────────────────────────────────────────────────────┐
│                    Connection State Machine                  │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│   UNINITIALIZED                                              │
│        │                                                      │
│        │ getConnection()                                     │
│        ↓                                                      │
│   CONNECTING ─────────────┐                                  │
│        │                  │ Timeout (5s)                     │
│        │ TCP handshake    ↓                                  │
│        │ + hello_peer    ERROR                               │
│        ↓                  │                                  │
│   AUTHENTICATING          │                                  │
│        │                  │ Auth failure                     │
│        │ hello_peer       │                                  │
│        │ success          │                                  │
│        ↓                  │                                  │
│   READY ◄─────────────────┘                                  │
│        │                  │                                  │
│        │ Activity         │ 10 min idle                      │
│        │ keeps alive      ↓                                  │
│        │            IDLE_PENDING                              │
│        │                  │                                  │
│        │                  │ Graceful close                   │
│        │                  ↓                                  │
│        │              CLOSING                                 │
│        │                  │                                  │
│        │ TCP error        │ Close complete                   │
│        ↓                  ↓                                  │
│   ERROR ──────────►  CLOSED                                  │
│        │                  ↑                                  │
│        │ Retry            │                                  │
│        └──────────────────┘                                  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### State Transition Details

**UNINITIALIZED → CONNECTING:**
- Triggered by: First call to peer
- Action: TCP socket.connect() to peer's connection string
- Timeout: 5 seconds (if connection fails)

**CONNECTING → AUTHENTICATING:**
- Triggered by: TCP connection established (3-way handshake complete)
- Action: Send hello_peer (0x01) message with our syncData
- Timeout: 5 seconds (if hello_peer response not received)

**AUTHENTICATING → READY:**
- Triggered by: hello_peer response received with status 200
- Action: Store peer's syncData, mark connection as authenticated
- Result: Connection ready for application messages

**READY → IDLE_PENDING:**
- Triggered by: No activity for 10 minutes (idle timer expires)
- Action: Set flag to close after current operations complete
- Allows in-flight messages to complete gracefully

**IDLE_PENDING → CLOSING:**
- Triggered by: All in-flight operations complete
- Action: Send proto_disconnect (0xF4), initiate TCP close
- Timeout: 2 seconds for graceful close

**CLOSING → CLOSED:**
- Triggered by: TCP FIN/ACK received or timeout
- Action: Release socket resources, remove from pool
- State: Connection fully terminated

**ERROR State:**
- Triggered by: TCP errors, timeout, auth failure
- Action: Immediate close, increment failure counter
- Retry: Managed by dead peer detection (Step 3)

**State Persistence:**
- Connection state stored per peer identity
- Survives temporary errors (can retry)
- Cleared on successful reconnection

## 2. Connection Lifecycle Implementation

### Connection Acquisition

```typescript
interface ConnectionOptions {
    timeout?: number           // Operation timeout (default: 3000ms)
    priority?: 'high' | 'normal' | 'low'
    retries?: number          // Retry count (default: 0)
    allowedErrors?: number[]  // Don't retry for these errors
}

class ConnectionPool {
    /**
     * Get or create connection to peer
     * Thread-safe with mutex per peer
     */
    async getConnection(
        peerIdentity: string,
        options: ConnectionOptions = {}
    ): Promise<PeerConnection> {
        // 1. Check if connection exists
        let conn = this.connections.get(peerIdentity)

        if (conn && conn.state === 'READY') {
            // Connection exists and ready, reset idle timer
            conn.resetIdleTimer()
            return conn
        }

        if (conn && conn.state === 'CONNECTING') {
            // Connection in progress, wait for it
            return await conn.waitForReady(options.timeout)
        }

        // 2. Connection doesn't exist or is closed, create new one
        conn = await this.createConnection(peerIdentity, options)
        this.connections.set(peerIdentity, conn)

        return conn
    }

    /**
     * Create new TCP connection and authenticate
     */
    private async createConnection(
        peerIdentity: string,
        options: ConnectionOptions
    ): Promise<PeerConnection> {
        const peer = PeerManager.getPeer(peerIdentity)
        if (!peer) {
            throw new Error(`Unknown peer: ${peerIdentity}`)
        }

        const conn = new PeerConnection(peer)

        try {
            // Phase 1: TCP connection (5 second timeout)
            await conn.connect(options.timeout ?? 5000)

            // Phase 2: Authentication (hello_peer exchange)
            await conn.authenticate(options.timeout ?? 5000)

            // Phase 3: Ready
            conn.state = 'READY'
            conn.startIdleTimer(this.config.idleTimeout)

            return conn
        } catch (error) {
            conn.state = 'ERROR'
            throw error
        }
    }
}
```

### PeerConnection Class

```typescript
class PeerConnection {
    public peer: Peer
    public socket: net.Socket | null = null
    public state: ConnectionState = 'UNINITIALIZED'

    private idleTimer: NodeJS.Timeout | null = null
    private lastActivity: number = 0
    private inFlightRequests: Map<number, PendingRequest> = new Map()
    private sendLock: AsyncMutex = new AsyncMutex()

    /**
     * Establish TCP connection
     */
    async connect(timeout: number): Promise<void> {
        this.state = 'CONNECTING'

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.socket?.destroy()
                reject(new Error('Connection timeout'))
            }, timeout)

            this.socket = net.connect({
                host: this.peer.connection.host,
                port: this.peer.connection.port,
            })

            this.socket.on('connect', () => {
                clearTimeout(timer)
                this.socket.setNoDelay(true)  // Disable Nagle
                this.socket.setKeepAlive(true, 60000)  // 60s keepalive
                resolve()
            })

            this.socket.on('error', (err) => {
                clearTimeout(timer)
                reject(err)
            })

            // Setup message handler
            this.setupMessageHandler()
        })
    }

    /**
     * Perform hello_peer handshake
     */
    async authenticate(timeout: number): Promise<void> {
        this.state = 'AUTHENTICATING'

        // Build hello_peer message (opcode 0x01)
        const payload = this.buildHelloPeerPayload()
        const response = await this.sendMessage(0x01, payload, timeout)

        if (response.statusCode !== 200) {
            throw new Error(`Authentication failed: ${response.statusCode}`)
        }

        // Store peer's syncData from response
        this.peer.sync = this.parseHelloPeerResponse(response.payload)
    }

    /**
     * Send binary message and wait for response
     */
    async sendMessage(
        opcode: number,
        payload: Buffer,
        timeout: number
    ): Promise<OmniResponse> {
        // Lock to ensure sequential sending
        return await this.sendLock.runExclusive(async () => {
            const messageId = this.generateMessageId()
            const message = this.buildMessage(opcode, payload, messageId)

            // Create promise for response
            const responsePromise = new Promise<OmniResponse>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.inFlightRequests.delete(messageId)
                    reject(new Error('Response timeout'))
                }, timeout)

                this.inFlightRequests.set(messageId, {
                    resolve,
                    reject,
                    timer,
                    sentAt: Date.now(),
                })
            })

            // Send message
            this.socket.write(message)
            this.lastActivity = Date.now()

            return await responsePromise
        })
    }

    /**
     * Setup message handler for incoming responses
     */
    private setupMessageHandler(): void {
        let buffer = Buffer.alloc(0)

        this.socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk])

            // Parse complete messages from buffer
            while (buffer.length >= 12) {  // Min header size
                const message = this.parseMessage(buffer)
                if (!message) break  // Incomplete message

                buffer = buffer.slice(message.totalLength)
                this.handleIncomingMessage(message)
            }

            this.lastActivity = Date.now()
        })
    }

    /**
     * Handle incoming message (response to our request)
     */
    private handleIncomingMessage(message: ParsedMessage): void {
        const pending = this.inFlightRequests.get(message.messageId)
        if (!pending) {
            log.warning(`Received response for unknown message ID: ${message.messageId}`)
            return
        }

        // Clear timeout and resolve promise
        clearTimeout(pending.timer)
        this.inFlightRequests.delete(message.messageId)

        pending.resolve({
            opcode: message.opcode,
            messageId: message.messageId,
            payload: message.payload,
            statusCode: this.extractStatusCode(message.payload),
        })
    }

    /**
     * Start idle timeout timer
     */
    startIdleTimer(timeout: number): void {
        this.resetIdleTimer()

        this.idleTimer = setInterval(() => {
            const idleTime = Date.now() - this.lastActivity
            if (idleTime >= timeout) {
                this.handleIdleTimeout()
            }
        }, 60000)  // Check every minute
    }

    /**
     * Reset idle timer (called on activity)
     */
    resetIdleTimer(): void {
        this.lastActivity = Date.now()
    }

    /**
     * Handle idle timeout
     */
    private async handleIdleTimeout(): Promise<void> {
        if (this.inFlightRequests.size > 0) {
            // Wait for in-flight requests
            this.state = 'IDLE_PENDING'
            return
        }

        await this.close(true)  // Graceful close
    }

    /**
     * Close connection
     */
    async close(graceful: boolean = true): Promise<void> {
        this.state = 'CLOSING'

        if (this.idleTimer) {
            clearInterval(this.idleTimer)
            this.idleTimer = null
        }

        if (graceful) {
            // Send proto_disconnect (0xF4)
            try {
                const payload = Buffer.from([0x00])  // Reason: idle timeout
                await this.sendMessage(0xF4, payload, 1000)
            } catch (err) {
                // Ignore errors on disconnect message
            }
        }

        // Reject all pending requests
        for (const [msgId, pending] of this.inFlightRequests) {
            clearTimeout(pending.timer)
            pending.reject(new Error('Connection closing'))
        }
        this.inFlightRequests.clear()

        // Close socket
        this.socket?.destroy()
        this.socket = null
        this.state = 'CLOSED'
    }
}
```

## 3. Timeout & Retry Patterns

### Operation Timeouts

**Timeout Hierarchy:**
```
┌─────────────────────────────────────────────────────────┐
│  Operation Type          │  Default  │  Max     │  Use  │
├─────────────────────────────────────────────────────────┤
│  Connection (TCP)        │  5000ms   │  10000ms │  Rare │
│  Authentication          │  5000ms   │  10000ms │  Rare │
│  call() (single RPC)     │  3000ms   │  30000ms │  Most │
│  longCall() (w/ retries) │  ~10s     │  90000ms │  Some │
│  multiCall() (parallel)  │  2000ms   │  10000ms │  Some │
│  Consensus ops           │  1000ms   │  5000ms  │  Crit │
│  Block sync              │  30000ms  │  300000ms│  Bulk │
└─────────────────────────────────────────────────────────┘
```

**Timeout Implementation:**
```typescript
class TimeoutManager {
    /**
     * Execute operation with timeout
     */
    static async withTimeout<T>(
        operation: Promise<T>,
        timeoutMs: number,
        errorMessage: string = 'Operation timeout'
    ): Promise<T> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        })

        return Promise.race([operation, timeoutPromise])
    }

    /**
     * Adaptive timeout based on peer latency history
     */
    static getAdaptiveTimeout(
        peer: Peer,
        baseTimeout: number,
        operation: string
    ): number {
        const history = peer.metrics?.latencyHistory ?? []
        if (history.length === 0) return baseTimeout

        // Use 95th percentile + buffer
        const p95 = this.percentile(history, 0.95)
        const adaptive = Math.min(p95 * 1.5, baseTimeout * 2)

        return Math.max(adaptive, baseTimeout)
    }
}
```

### Retry Strategy: Enhanced longCall

**Current HTTP Behavior:**
- Fixed retries (default 3)
- Fixed sleep interval (250ms-1000ms)
- Allowed error codes (don't retry)

**OmniProtocol Enhancement:**
```typescript
interface RetryOptions {
    maxRetries: number        // Default: 3
    initialDelay: number      // Default: 250ms
    backoffMultiplier: number // Default: 1.0 (no backoff)
    maxDelay: number          // Default: 1000ms
    allowedErrors: number[]   // Don't retry for these
    retryOnTimeout: boolean   // Default: true
}

class RetryManager {
    /**
     * Execute with retry logic
     */
    static async withRetry<T>(
        operation: () => Promise<T>,
        options: RetryOptions = {}
    ): Promise<T> {
        const config = {
            maxRetries: options.maxRetries ?? 3,
            initialDelay: options.initialDelay ?? 250,
            backoffMultiplier: options.backoffMultiplier ?? 1.0,
            maxDelay: options.maxDelay ?? 1000,
            allowedErrors: options.allowedErrors ?? [],
            retryOnTimeout: options.retryOnTimeout ?? true,
        }

        let lastError: Error
        let delay = config.initialDelay

        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            try {
                return await operation()
            } catch (error) {
                lastError = error

                // Check if error is in allowed list
                if (error.code && config.allowedErrors.includes(error.code)) {
                    return error as T  // Treat as success
                }

                // Check if we should retry
                if (attempt >= config.maxRetries) {
                    break  // Max retries reached
                }

                if (!config.retryOnTimeout && error.message.includes('timeout')) {
                    break  // Don't retry timeouts
                }

                // Sleep before retry
                await new Promise(resolve => setTimeout(resolve, delay))

                // Exponential backoff
                delay = Math.min(
                    delay * config.backoffMultiplier,
                    config.maxDelay
                )
            }
        }

        throw lastError
    }
}
```

### Circuit Breaker Pattern

**Purpose**: Prevent cascading failures when peer is consistently failing

```typescript
class CircuitBreaker {
    private failureCount: number = 0
    private lastFailureTime: number = 0
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED'

    constructor(
        private threshold: number = 5,           // Failures before open
        private timeout: number = 30000,         // 30s timeout
        private successThreshold: number = 2     // Successes to close
    ) {}

    async execute<T>(operation: () => Promise<T>): Promise<T> {
        // Check circuit state
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime < this.timeout) {
                throw new Error('Circuit breaker is OPEN')
            }
            // Timeout elapsed, try half-open
            this.state = 'HALF_OPEN'
        }

        try {
            const result = await operation()
            this.onSuccess()
            return result
        } catch (error) {
            this.onFailure()
            throw error
        }
    }

    private onSuccess(): void {
        if (this.state === 'HALF_OPEN') {
            this.successCount++
            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED'
                this.failureCount = 0
                this.successCount = 0
            }
        } else {
            this.failureCount = 0
        }
    }

    private onFailure(): void {
        this.failureCount++
        this.lastFailureTime = Date.now()

        if (this.failureCount >= this.threshold) {
            this.state = 'OPEN'
        }
    }
}
```

## 4. Concurrency & Resource Management

### Concurrent Request Limiting

**Per-Connection Limits:**
```typescript
class PeerConnection {
    private maxConcurrentRequests: number = 100
    private activeRequests: number = 0
    private requestQueue: QueuedRequest[] = []

    /**
     * Acquire slot for request (with backpressure)
     */
    private async acquireRequestSlot(): Promise<void> {
        if (this.activeRequests < this.maxConcurrentRequests) {
            this.activeRequests++
            return
        }

        // Wait in queue
        return new Promise<void>((resolve) => {
            this.requestQueue.push({ resolve })
        })
    }

    /**
     * Release slot after request completes
     */
    private releaseRequestSlot(): void {
        this.activeRequests--

        // Process queue
        if (this.requestQueue.length > 0) {
            const next = this.requestQueue.shift()
            this.activeRequests++
            next.resolve()
        }
    }

    /**
     * Send with concurrency control
     */
    async sendMessage(
        opcode: number,
        payload: Buffer,
        timeout: number
    ): Promise<OmniResponse> {
        await this.acquireRequestSlot()

        try {
            return await this.sendMessageInternal(opcode, payload, timeout)
        } finally {
            this.releaseRequestSlot()
        }
    }
}
```

### Global Connection Limits

```typescript
class ConnectionPool {
    private maxTotalConnections: number = 1000
    private maxConnectionsPerPeer: number = 1

    /**
     * Check if we can create new connection
     */
    private canCreateConnection(): boolean {
        const totalConnections = this.connections.size
        return totalConnections < this.maxTotalConnections
    }

    /**
     * Evict least recently used connection if needed
     */
    private async evictLRUConnection(): Promise<void> {
        let oldestConn: PeerConnection | null = null
        let oldestActivity = Date.now()

        for (const conn of this.connections.values()) {
            if (conn.state === 'READY' && conn.lastActivity < oldestActivity) {
                oldestActivity = conn.lastActivity
                oldestConn = conn
            }
        }

        if (oldestConn) {
            await oldestConn.close(true)
            this.connections.delete(oldestConn.peer.identity)
        }
    }
}
```

### Memory Management

**Buffer Pool for Messages:**
```typescript
class BufferPool {
    private pools: Map<number, Buffer[]> = new Map()
    private sizes = [256, 1024, 4096, 16384, 65536]  // Common sizes

    /**
     * Acquire buffer from pool
     */
    acquire(size: number): Buffer {
        const poolSize = this.getPoolSize(size)
        const pool = this.pools.get(poolSize) ?? []

        if (pool.length > 0) {
            return pool.pop()
        }

        return Buffer.allocUnsafe(poolSize)
    }

    /**
     * Release buffer back to pool
     */
    release(buffer: Buffer): void {
        const size = buffer.length
        if (!this.pools.has(size)) {
            this.pools.set(size, [])
        }

        const pool = this.pools.get(size)
        if (pool.length < 100) {  // Max 100 buffers per size
            buffer.fill(0)  // Clear for security
            pool.push(buffer)
        }
    }

    private getPoolSize(requested: number): number {
        for (const size of this.sizes) {
            if (size >= requested) return size
        }
        return requested  // Larger than any pool
    }
}
```

## 5. Thread Safety & Synchronization

### Async Mutex Implementation

```typescript
class AsyncMutex {
    private locked: boolean = false
    private queue: Array<() => void> = []

    async lock(): Promise<void> {
        if (!this.locked) {
            this.locked = true
            return
        }

        return new Promise<void>((resolve) => {
            this.queue.push(resolve)
        })
    }

    unlock(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift()
            next()  // Locked passes to next waiter
        } else {
            this.locked = false
        }
    }

    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        await this.lock()
        try {
            return await fn()
        } finally {
            this.unlock()
        }
    }
}
```

### Concurrent Operations Safety

**Read-Write Locks for Peer State:**
```typescript
class PeerStateLock {
    private readers: number = 0
    private writer: boolean = false
    private writerQueue: Array<() => void> = []
    private readerQueue: Array<() => void> = []

    async acquireRead(): Promise<void> {
        if (!this.writer && this.writerQueue.length === 0) {
            this.readers++
            return
        }

        return new Promise<void>((resolve) => {
            this.readerQueue.push(resolve)
        })
    }

    releaseRead(): void {
        this.readers--
        this.checkWaiting()
    }

    async acquireWrite(): Promise<void> {
        if (!this.writer && this.readers === 0) {
            this.writer = true
            return
        }

        return new Promise<void>((resolve) => {
            this.writerQueue.push(resolve)
        })
    }

    releaseWrite(): void {
        this.writer = false
        this.checkWaiting()
    }

    private checkWaiting(): void {
        if (this.writer || this.readers > 0) return

        // Prioritize writers
        if (this.writerQueue.length > 0) {
            const next = this.writerQueue.shift()
            this.writer = true
            next()
        } else if (this.readerQueue.length > 0) {
            // Wake all readers
            while (this.readerQueue.length > 0) {
                const next = this.readerQueue.shift()
                this.readers++
                next()
            }
        }
    }
}
```

## 6. Error Handling & Recovery

### Error Classification

```typescript
enum ErrorSeverity {
    TRANSIENT,    // Retry immediately
    DEGRADED,     // Retry with backoff
    FATAL,        // Don't retry, mark offline
}

class ErrorClassifier {
    static classify(error: Error): ErrorSeverity {
        // Connection errors
        if (error.message.includes('ECONNREFUSED')) {
            return ErrorSeverity.FATAL  // Peer offline
        }

        if (error.message.includes('ETIMEDOUT')) {
            return ErrorSeverity.DEGRADED  // Network issues
        }

        if (error.message.includes('ECONNRESET')) {
            return ErrorSeverity.DEGRADED  // Connection dropped
        }

        // Protocol errors
        if (error.message.includes('Authentication failed')) {
            return ErrorSeverity.FATAL  // Invalid credentials
        }

        if (error.message.includes('Protocol version')) {
            return ErrorSeverity.FATAL  // Incompatible
        }

        // Timeout errors
        if (error.message.includes('timeout')) {
            return ErrorSeverity.TRANSIENT  // Try again
        }

        // Default
        return ErrorSeverity.DEGRADED
    }
}
```

### Recovery Strategies

```typescript
class ConnectionRecovery {
    static async handleConnectionError(
        conn: PeerConnection,
        error: Error
    ): Promise<void> {
        const severity = ErrorClassifier.classify(error)

        switch (severity) {
            case ErrorSeverity.TRANSIENT:
                // Quick retry
                log.info(`Transient error, retrying: ${error.message}`)
                await conn.reconnect()
                break

            case ErrorSeverity.DEGRADED:
                // Close and mark for retry
                log.warning(`Degraded error, closing: ${error.message}`)
                await conn.close(false)
                PeerManager.markPeerDegraded(conn.peer.identity)
                break

            case ErrorSeverity.FATAL:
                // Mark offline
                log.error(`Fatal error, marking offline: ${error.message}`)
                await conn.close(false)
                PeerManager.markPeerOffline(conn.peer.identity, error.message)
                break
        }
    }
}
```

## 7. Monitoring & Metrics

### Connection Metrics

```typescript
interface ConnectionMetrics {
    // Counts
    totalConnections: number
    activeConnections: number
    idleConnections: number

    // Performance
    avgLatency: number
    p50Latency: number
    p95Latency: number
    p99Latency: number

    // Errors
    connectionFailures: number
    timeoutErrors: number
    authFailures: number

    // Resource usage
    totalMemory: number
    bufferPoolSize: number
    inFlightRequests: number
}

class MetricsCollector {
    private metrics: Map<string, number[]> = new Map()

    recordLatency(peer: string, latency: number): void {
        const history = this.metrics.get(`${peer}:latency`) ?? []
        history.push(latency)
        if (history.length > 100) history.shift()
        this.metrics.set(`${peer}:latency`, history)
    }

    recordError(peer: string, errorType: string): void {
        const key = `${peer}:error:${errorType}`
        const count = this.metrics.get(key)?.[0] ?? 0
        this.metrics.set(key, [count + 1])
    }

    getStats(peer: string): ConnectionMetrics {
        const latencyHistory = this.metrics.get(`${peer}:latency`) ?? []

        return {
            totalConnections: this.countConnections(),
            activeConnections: this.countActive(),
            idleConnections: this.countIdle(),
            avgLatency: this.avg(latencyHistory),
            p50Latency: this.percentile(latencyHistory, 0.50),
            p95Latency: this.percentile(latencyHistory, 0.95),
            p99Latency: this.percentile(latencyHistory, 0.99),
            connectionFailures: this.getErrorCount(peer, 'connection'),
            timeoutErrors: this.getErrorCount(peer, 'timeout'),
            authFailures: this.getErrorCount(peer, 'auth'),
            totalMemory: process.memoryUsage().heapUsed,
            bufferPoolSize: this.getBufferPoolSize(),
            inFlightRequests: this.countInFlight(),
        }
    }
}
```

## 8. Integration with Peer Class

### Updated Peer.ts Interface

```typescript
class Peer {
    // Existing fields (unchanged)
    public connection: { string: string }
    public identity: string
    public verification: { status: boolean; message: string; timestamp: number }
    public sync: SyncData
    public status: { online: boolean; timestamp: number; ready: boolean }

    // New OmniProtocol fields
    private omniConnection: PeerConnection | null = null
    private circuitBreaker: CircuitBreaker = new CircuitBreaker()

    /**
     * call() - Maintains exact same signature
     */
    async call(
        request: RPCRequest,
        isAuthenticated = true
    ): Promise<RPCResponse> {
        // Determine protocol from connection string
        if (this.connection.string.startsWith('tcp://')) {
            return await this.callOmniProtocol(request, isAuthenticated)
        } else {
            return await this.callHTTP(request, isAuthenticated)  // Existing
        }
    }

    /**
     * OmniProtocol call implementation
     */
    private async callOmniProtocol(
        request: RPCRequest,
        isAuthenticated: boolean
    ): Promise<RPCResponse> {
        return await this.circuitBreaker.execute(async () => {
            // Get or create connection
            const conn = await ConnectionPool.getConnection(
                this.identity,
                { timeout: 3000 }
            )

            // Convert RPC request to OmniProtocol message
            const { opcode, payload } = this.convertToOmniMessage(
                request,
                isAuthenticated
            )

            // Send message
            const response = await conn.sendMessage(opcode, payload, 3000)

            // Convert back to RPC response
            return this.convertFromOmniMessage(response)
        })
    }

    /**
     * longCall() - Maintains exact same signature
     */
    async longCall(
        request: RPCRequest,
        isAuthenticated = true,
        sleepTime = 250,
        retries = 3,
        allowedErrors: number[] = []
    ): Promise<RPCResponse> {
        return await RetryManager.withRetry(
            () => this.call(request, isAuthenticated),
            {
                maxRetries: retries,
                initialDelay: sleepTime,
                allowedErrors: allowedErrors,
            }
        )
    }

    /**
     * multiCall() - Maintains exact same signature
     */
    static async multiCall(
        request: RPCRequest,
        isAuthenticated = true,
        peers: Peer[],
        timeout = 2000
    ): Promise<RPCResponse[]> {
        const promises = peers.map(peer =>
            TimeoutManager.withTimeout(
                peer.call(request, isAuthenticated),
                timeout,
                `Peer ${peer.identity} timeout`
            )
        )

        return await Promise.allSettled(promises).then(results =>
            results.map(r =>
                r.status === 'fulfilled'
                    ? r.value
                    : { result: 500, response: r.reason.message, require_reply: false, extra: null }
            )
        )
    }
}
```

## 9. Performance Characteristics

### Connection Overhead Analysis

**Initial Connection (Cold Start):**
```
TCP Handshake:        3 RTTs  (~30-90ms typical)
hello_peer exchange:  1 RTT   (~10-30ms typical)
Total:                4 RTTs  (~40-120ms typical)
```

**Warm Connection (Reuse):**
```
Message send:         0 RTTs  (immediate)
Response wait:        1 RTT   (~10-30ms typical)
Total:                1 RTT   (~10-30ms typical)
```

**Bandwidth Savings:**
- No HTTP headers (400-800 bytes) on every request
- Binary protocol overhead: 12 bytes (header) vs ~500 bytes (HTTP)
- **Savings: ~97% overhead reduction**

### Scalability Targets

**1,000 Peer Scenario:**
```
Active connections:     50-100 (5-10% typical)
Idle timeout closes:    900-950 connections
Memory per connection:  ~4-8 KB
Total memory overhead:  ~400 KB - 800 KB

Requests/second:        10,000+ (with connection reuse)
Latency (p95):          <50ms (for warm connections)
CPU overhead:           <5% (binary parsing minimal)
```

**10,000 Peer Scenario:**
```
Active connections:     500-1000 (5-10% typical)
Connection limit:       Configurable max (e.g., 2000)
Memory overhead:        ~4-8 MB (manageable)
LRU eviction:           Automatic for >max limit
```

## 10. Migration & Compatibility

### Gradual Rollout Strategy

**Phase 1: Dual Protocol (Both HTTP + TCP)**
```typescript
class Peer {
    async call(request: RPCRequest): Promise<RPCResponse> {
        // Try OmniProtocol first
        if (this.supportsOmniProtocol()) {
            try {
                return await this.callOmniProtocol(request)
            } catch (error) {
                log.warning('OmniProtocol failed, falling back to HTTP')
                // Fall through to HTTP
            }
        }

        // Fallback to HTTP
        return await this.callHTTP(request)
    }

    private supportsOmniProtocol(): boolean {
        // Check if peer advertises TCP support
        return this.connection.string.startsWith('tcp://') ||
               this.capabilities?.includes('omniprotocol')
    }
}
```

**Phase 2: TCP Primary, HTTP Fallback**
```typescript
// Same as Phase 1 but with metrics to track fallback rate
// Goal: <1% fallback rate before Phase 3
```

**Phase 3: TCP Only**
```typescript
class Peer {
    async call(request: RPCRequest): Promise<RPCResponse> {
        // No fallback, TCP only
        return await this.callOmniProtocol(request)
    }
}
```

## Summary

### Key Design Points

✅ **Connection Pooling**: One persistent TCP connection per peer
✅ **Idle Timeout**: 10 minutes with graceful closure
✅ **Timeouts**: 3s call, 5s connect/auth, configurable per operation
✅ **Retry**: Enhanced longCall with exponential backoff support
✅ **Circuit Breaker**: 5 failures threshold, 30s timeout
✅ **Concurrency**: 100 requests/connection, 1000 total connections
✅ **Thread Safety**: Async mutex for send, read-write locks for state
✅ **Error Recovery**: Classified errors with appropriate strategies
✅ **Monitoring**: Comprehensive metrics for latency, errors, resources
✅ **Compatibility**: Maintains exact Peer class API, dual protocol support

### Performance Benefits

**Connection Reuse:**
- 40-120ms initial → 10-30ms subsequent (70-90% improvement)

**Bandwidth:**
- ~97% overhead reduction vs HTTP

**Scalability:**
- 1,000 peers: ~400-800 KB memory
- 10,000 peers: ~4-8 MB memory
- 10,000+ req/s throughput

### Next Steps

**Step 5**: Payload Structures - Binary encoding for all 9 opcode categories
**Step 6**: Module Structure - TypeScript architecture and interfaces
**Step 7**: Implementation Plan - Testing, migration, rollout strategy
