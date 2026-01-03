# TLSNotary SDK Integration Guide

This document describes how to integrate TLSNotary attestation capabilities into SDK clients.

## Overview

The Demos Network node provides dynamic WebSocket proxy management for TLSNotary attestations. When an SDK wants to attest a web request, it:

1. Calls `requestTLSNproxy` to get a proxy URL for the target domain
2. Uses that proxy URL with `tlsn-js` to perform the attestation
3. The proxy auto-expires after 30 seconds of inactivity

## Endpoints

### `requestTLSNproxy` - Request WebSocket Proxy

Request a WebSocket-to-TCP proxy for a target domain. The node spawns a `wstcp` process and returns the proxy URL.

#### Request

```typescript
// Via nodeCall
{
  method: "nodeCall",
  params: [{
    message: "requestTLSNproxy",
    data: {
      targetUrl: "https://api.example.com/endpoint",
      authentication?: {           // Optional, future use
        pubKey: string,
        signature: string
      }
    },
    muid: "optional-message-id"
  }]
}
```

#### Success Response

```typescript
{
  result: 200,
  response: {
    websocketProxyUrl: "ws://node.demos.sh:55123",
    targetDomain: "api.example.com",
    expiresIn: 30000,     // ms until auto-cleanup (resets on activity)
    proxyId: "uuid-here"
  }
}
```

#### Error Responses

**Invalid URL (400)**
```typescript
{
  result: 400,
  response: {
    error: "INVALID_URL",
    message: "Only HTTPS URLs are supported for TLS attestation"
  }
}
```

**Spawn Failed (500)**
```typescript
{
  result: 500,
  response: {
    error: "PROXY_SPAWN_FAILED",
    message: "Failed to spawn proxy after 3 attempts",
    targetDomain: "api.example.com",
    lastError: "Port 55003 already in use"
  }
}
```

**Port Exhausted (500)**
```typescript
{
  result: 500,
  response: {
    error: "PORT_EXHAUSTED",
    message: "All ports in range 55000-57000 are exhausted",
    targetDomain: "api.example.com"
  }
}
```

**wstcp Not Available (500)**
```typescript
{
  result: 500,
  response: {
    error: "WSTCP_NOT_AVAILABLE",
    message: "Failed to install wstcp: ..."
  }
}
```

### `tlsnotary.getInfo` - Discovery Endpoint

Get TLSNotary service information for SDK auto-configuration.

#### Request

```typescript
{
  method: "nodeCall",
  params: [{
    message: "tlsnotary.getInfo",
    data: {},
    muid: "optional-message-id"
  }]
}
```

#### Response

```typescript
{
  result: 200,
  response: {
    notaryUrl: "wss://node.demos.sh:7047",
    proxyUrl: "wss://node.demos.sh:55688",   // Default proxy (deprecated, use requestTLSNproxy)
    publicKey: "hex-encoded-secp256k1-pubkey",
    version: "0.1.0"
  }
}
```

## SDK Usage Example

```typescript
import { Prover } from 'tlsn-js';

async function attestRequest(targetUrl: string) {
  // 1. Request a proxy for the target domain
  const proxyResponse = await sdk.nodeCall({
    message: "requestTLSNproxy",
    data: { targetUrl }
  });

  if (proxyResponse.error) {
    throw new Error(`Failed to get proxy: ${proxyResponse.message}`);
  }

  const { websocketProxyUrl, targetDomain } = proxyResponse;

  // 2. Get notary info
  const notaryInfo = await sdk.nodeCall({
    message: "tlsnotary.getInfo",
    data: {}
  });

  // 3. Perform attestation using tlsn-js
  const presentation = await Prover.notarize({
    notaryUrl: notaryInfo.notaryUrl,
    websocketProxyUrl: websocketProxyUrl,
    maxRecvData: 4096,
    url: targetUrl,
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
    commit: {
      sent: [{ start: 0, end: 100 }],
      recv: [{ start: 0, end: 200 }],
    },
  });

  return presentation;
}
```

## Proxy Lifecycle

1. **Creation**: When `requestTLSNproxy` is called, if no proxy exists for the domain, a new `wstcp` process is spawned on an available port (55000-57000)

2. **Reuse**: Subsequent requests for the same domain return the existing proxy (with updated `expiresIn`)

3. **Activity Tracking**: Any stdout/stderr activity from the wstcp process resets the 30-second idle timer

4. **Cleanup**: Proxies idle for >30 seconds are killed lazily (on the next request)

5. **Port Recycling**: Released ports are recycled for future proxies

## Configuration

The node uses these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `TLSNOTARY_DISABLED` | Set to `true` to disable TLSNotary | `false` (enabled) |
| `TLSNOTARY_PORT` | WebSocket port for notary server | `7047` |
| `EXPOSED_URL` | Public URL for building proxy URLs | Auto-detected |

## Error Handling Best Practices

1. **Retry on spawn failures**: The node retries 3x automatically, but SDK should have additional retry logic

2. **Handle port exhaustion**: If `PORT_EXHAUSTED` error occurs, wait and retry or report to user

3. **Validate URLs**: Always ensure target URL is HTTPS before calling

4. **Check service availability**: Use `tlsnotary.getInfo` to verify the service is running before attestation attempts

## Security Considerations

1. **HTTPS Only**: Only HTTPS URLs are supported for attestation (TLS is required)

2. **Port Range**: Proxies use ports 55000-57000, ensure firewall allows these if needed

3. **Authentication** (Future): The `authentication` field will be used for rate limiting and access control

4. **Ephemeral**: Proxy state is not persisted - all proxies are killed on node restart
