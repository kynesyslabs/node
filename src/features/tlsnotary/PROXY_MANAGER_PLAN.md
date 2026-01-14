# TLSNotary WebSocket Proxy Manager - Implementation Plan

## Overview

Dynamic wstcp proxy spawning system for domain-specific TLS attestation requests.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SDK Request                                   │
│              nodeCall({ action: "requestTLSNproxy", ... })              │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      TLSNotary Proxy Manager                            │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────────┐   │
│  │  Port Allocator │  │  Proxy Registry  │  │  Lifecycle Manager    │   │
│  │  55000-57000    │  │  (sharedState)   │  │  (stdout monitor +    │   │
│  │  sequential +   │  │                  │  │   lazy cleanup)       │   │
│  │  recycle        │  │                  │  │                       │   │
│  └────────┬────────┘  └────────┬─────────┘  └───────────┬───────────┘   │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                        │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        wstcp Processes                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐       │
│  │ :55000 → api.com │  │ :55001 → x.io    │  │ :55002 → ...     │       │
│  │ (idle: 12s)      │  │ (idle: 5s)       │  │ (idle: 28s)      │       │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Decisions Summary

| Aspect | Decision |
|--------|----------|
| Proxy Granularity | One per domain (shared) |
| Port Allocation | Sequential 55000→57000, then recycle freed |
| Public URL | Auto-detect → `EXPOSED_URL` → IP fallback |
| Concurrency | Separate proxies per request |
| Failure Handling | Retry 3x with different ports, then diagnostic error |
| Usage Detection | Any wstcp stdout activity resets 30s idle timer |
| Cleanup | Lazy - on next request, clean stale proxies |
| wstcp Binary | Expect in PATH, `cargo install wstcp` if missing |
| Endpoint | nodeCall action: `requestTLSNproxy` |
| Response | Extended with proxyId, expiresIn, targetDomain |
| State | `sharedState.tlsnotary = { proxies, portPool }` |
| Persistence | None - ephemeral, dies with node |
| Port inference | :443 from https, unless URL contains explicit port |

## Data Structures

### sharedState.tlsnotary

```typescript
interface TLSNotaryState {
  proxies: Map<string, ProxyInfo>  // keyed by domain
  portPool: {
    next: number      // next port to try (55000-57000)
    max: number       // 57000
    recycled: number[] // freed ports available for reuse
  }
}

interface ProxyInfo {
  proxyId: string           // uuid
  domain: string            // "api.example.com"
  port: number              // 55123
  process: ChildProcess     // wstcp process handle
  lastActivity: number      // Date.now() timestamp
  spawnedAt: number         // Date.now() timestamp
  websocketProxyUrl: string // "ws://node.demos.sh:55123"
}
```

## API Contract

### Request (nodeCall)

```typescript
{
  action: "requestTLSNproxy",
  targetUrl: "https://api.example.com/endpoint",
  authentication?: {        // optional, future use
    pubKey: string,
    signature: string
  }
}
```

### Success Response

```typescript
{
  websocketProxyUrl: "ws://node.demos.sh:55123",
  targetDomain: "api.example.com",
  expiresIn: 30000,   // ms until auto-cleanup (resets on activity)
  proxyId: "uuid-here"
}
```

### Error Response

```typescript
{
  error: "PROXY_SPAWN_FAILED",
  message: "Failed to spawn proxy after 3 attempts",
  targetDomain: "api.example.com",
  lastError: "Port 55003 already in use"
}
```

## Lifecycle Flow

```
1. SDK calls requestTLSNproxy({ targetUrl: "https://api.example.com/..." })
   │
2. Extract domain + port: "api.example.com:443" (443 inferred from https)
   │   - If URL has explicit port like https://api.example.com:8443, use that
   │
3. Lazy cleanup: scan proxies, kill any with lastActivity > 30s ago
   │
4. Check if proxy exists for domain
   │
   ├─► EXISTS & ALIVE → update lastActivity, return existing proxy info
   │
   └─► NOT EXISTS
       │
       4a. Allocate port (recycled.pop() || next++)
       │
       4b. Spawn: wstcp --bind-addr 0.0.0.0:{port} {domain}:{targetPort}
           │
           ├─► FAIL → retry up to 3x with new port
           │
           └─► SUCCESS
               │
               4c. Attach stdout listener (any output → reset lastActivity)
               │
               4d. Register in sharedState.tlsnotary.proxies
               │
               4e. Return ProxyInfo
```

## Files to Create/Modify

### New Files

1. **src/features/tlsnotary/proxyManager.ts** - Main proxy lifecycle management
   - `ensureWstcp()` - Check/install wstcp binary
   - `extractDomainAndPort(url)` - Parse target URL
   - `getPublicUrl(port)` - Build websocketProxyUrl
   - `spawnProxy(domain, targetPort)` - Spawn wstcp process
   - `cleanupStaleProxies()` - Lazy cleanup
   - `requestProxy(targetUrl)` - Main entry point
   - `killProxy(proxyId)` - Manual cleanup if needed

2. **src/features/tlsnotary/portAllocator.ts** - Port pool management
   - `initPortPool()` - Initialize pool state
   - `allocatePort()` - Get next available port
   - `releasePort(port)` - Return port to recycled pool
   - `isPortAvailable(port)` - Check if port is free

3. **src/features/tlsnotary/SDK_INTEGRATION.md** - SDK integration docs

### Files to Modify

1. **src/utilities/sharedState.ts**
   - Add `tlsnotary` property with type `TLSNotaryState`
   - Initialize in constructor

2. **src/libs/network/server_rpc.ts** (or wherever nodeCall handlers are)
   - Add handler for `action: "requestTLSNproxy"`
   - Import and call `requestProxy()` from proxyManager

3. **src/libs/network/docs_nodeCall.md**
   - Document new `requestTLSNproxy` action

4. **src/libs/network/methodListing.ts**
   - Add to availableMethods if needed

## Implementation Order

1. [ ] Create `portAllocator.ts` - port pool management
2. [ ] Create `proxyManager.ts` - proxy lifecycle management
3. [ ] Modify `sharedState.ts` - add tlsnotary state
4. [ ] Add nodeCall handler for `requestTLSNproxy`
5. [ ] Test manually with curl/SDK
6. [ ] Create `SDK_INTEGRATION.md` documentation

## Public URL Resolution Logic

```typescript
function getPublicUrl(port: number, requestOrigin?: string): string {
  // 1. Try auto-detect from request origin (if available in headers)
  if (requestOrigin) {
    const url = new URL(requestOrigin)
    return `ws://${url.hostname}:${port}`
  }

  // 2. Fall back to EXPOSED_URL
  if (process.env.EXPOSED_URL) {
    const url = new URL(process.env.EXPOSED_URL)
    return `ws://${url.hostname}:${port}`
  }

  // 3. Fall back to sharedState.exposedUrl or connectionString
  const sharedState = SharedState.getInstance()
  const url = new URL(sharedState.exposedUrl)
  return `ws://${url.hostname}:${port}`
}
```

## wstcp Binary Check

```typescript
async function ensureWstcp(): Promise<void> {
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)

  try {
    await execAsync('which wstcp')
    log.debug('[TLSNotary] wstcp binary found')
  } catch {
    log.info('[TLSNotary] wstcp not found, installing via cargo...')
    try {
      await execAsync('cargo install wstcp')
      log.info('[TLSNotary] wstcp installed successfully')
    } catch (installError) {
      throw new Error(`Failed to install wstcp: ${installError.message}`)
    }
  }
}
```

## Domain/Port Extraction

```typescript
function extractDomainAndPort(targetUrl: string): { domain: string; port: number } {
  const url = new URL(targetUrl)
  const domain = url.hostname

  // If explicit port in URL, use it
  if (url.port) {
    return { domain, port: parseInt(url.port, 10) }
  }

  // Otherwise infer from protocol
  const port = url.protocol === 'https:' ? 443 : 80
  return { domain, port }
}
```

## Stdout Activity Monitor

```typescript
function attachActivityMonitor(process: ChildProcess, proxyInfo: ProxyInfo): void {
  // Any stdout activity resets the idle timer
  process.stdout?.on('data', () => {
    proxyInfo.lastActivity = Date.now()
  })

  process.stderr?.on('data', () => {
    proxyInfo.lastActivity = Date.now()
  })

  process.on('exit', (code) => {
    log.info(`[TLSNotary] Proxy for ${proxyInfo.domain} exited with code ${code}`)
    // Cleanup will happen lazily on next request
  })
}
```

## Constants

```typescript
const PROXY_CONFIG = {
  PORT_MIN: 55000,
  PORT_MAX: 57000,
  IDLE_TIMEOUT_MS: 30000,  // 30 seconds
  MAX_SPAWN_RETRIES: 3,
  SPAWN_TIMEOUT_MS: 5000,  // 5 seconds to wait for wstcp to start
}
```

## Error Codes

```typescript
enum ProxyError {
  PROXY_SPAWN_FAILED = 'PROXY_SPAWN_FAILED',
  PORT_EXHAUSTED = 'PORT_EXHAUSTED',
  INVALID_URL = 'INVALID_URL',
  WSTCP_NOT_AVAILABLE = 'WSTCP_NOT_AVAILABLE',
}
```
