# OmniProtocol - SDK Client Communication Analysis

## SDK Communication Patterns (from ../sdks)

### Primary Client Class: Demos (demosclass.ts)

The Demos class is the main SDK entry point for client-to-node communication.

#### HTTP Communication Methods

**1. rpcCall() - Low-level RPC wrapper**
- Location: Lines 502-562
- Method: `axios.post<RPCResponse>(this.rpc_url, request, headers)`
- Authentication: Optional with signature headers
- Features:
  - Retry mechanism (configurable retries + sleep)
  - Allowed error codes for partial success
  - Signature-based auth (algorithm + publicKey in headers)
  - Result code checking (200 or allowedErrorCodes)

**2. call() - High-level abstracted call**
- Location: Lines 565-643  
- Method: `axios.post<RPCResponse>(this.rpc_url, request, headers)`
- Authentication: Automatic (except for "nodeCall")
- Uses transmission bundle structure (legacy)
- Returns response.data or response.data.response based on method

**3. connect() - Node connection test**
- Location: Lines 109-118
- Method: `axios.get(rpc_url)` 
- Simple health check to validate RPC URL
- Sets this.connected = true on success

### SDK-Specific Communication Characteristics

#### Authentication Pattern (matches node expectations)
```typescript
headers: {
    "Content-Type": "application/json",
    identity: "<algorithm>:<hex_publickey>",  
    signature: "<hex_signature_of_publickey>"
}
```

Supported algorithms:
- ed25519 (primary)
- falcon (post-quantum)
- ml-dsa (post-quantum)

#### Request Format
```typescript
interface RPCRequest {
    method: string
    params: any[]
}
```

#### Response Format  
```typescript
interface RPCResponse {
    result: number
    response: any
    require_reply: boolean
    extra: any
}
```

### Client-Side Methods Using Node Communication

#### NodeCall Methods (No Authentication)
All use `demos.nodeCall(message, args)` which wraps `call("nodeCall", ...)`:

- **getLastBlockNumber()**: Query last block number
- **getLastBlockHash()**: Query last block hash
- **getBlocks(start, limit)**: Fetch block range
- **getBlockByNumber(n)**: Fetch specific block by number
- **getBlockByHash(hash)**: Fetch specific block by hash
- **getTxByHash(hash)**: Fetch transaction by hash
- **getTransactionHistory(address, type, options)**: Query tx history
- **getTransactions(start, limit)**: Fetch transaction range
- **getPeerlist()**: Get node's peer list
- **getMempool()**: Get current mempool
- **getPeerIdentity()**: Get node's identity
- **getAddressInfo(address)**: Query address state
- **getAddressNonce(address)**: Get address nonce
- **getTweet(tweetUrl)**: Fetch tweet data (web2)
- **getDiscordMessage(discordUrl)**: Fetch Discord message (web2)

#### Authenticated Transaction Methods
- **confirm(transaction)**: Get validity data and gas info
- **broadcast(validationData)**: Execute transaction on network

#### Web2 Integration
- **web2.createDahr()**: Create decentralized authenticated HTTP request
- **web2.getTweet()**: Fetch tweet through node
- **web2.getDiscordMessage()**: Fetch Discord message through node

### SDK Communication Flow

**Standard Transaction Flow:**
```
1. demos.connect(rpc_url)           // axios.get health check
2. demos.connectWallet(seed)        // local crypto setup
3. demos.pay(to, amount)            // create transaction
4. demos.sign(tx)                   // sign locally
5. demos.confirm(tx)                // POST to node (authenticated)
6. demos.broadcast(validityData)    // POST to node (authenticated)
```

**Query Flow:**
```
1. demos.connect(rpc_url)
2. demos.getAddressInfo(address)    // POST with method: "nodeCall"
   // No authentication needed for read operations
```

### Critical SDK Communication Features

#### 1. Retry Logic (rpcCall method)
- Configurable retries (default 0)
- Sleep between retries (default 250ms)
- Allowed error codes for partial success
- Matches node's longCall pattern

#### 2. Dual Signing Support
- PQC signature + ed25519 signature
- Used when: PQC algorithm + dual_sign flag
- Adds ed25519_signature to transaction
- Matches node's multi-algorithm support

#### 3. Connection Management
- Single RPC URL per instance
- Connection status tracking
- Wallet connection status separate from node connection

#### 4. Error Handling
- Catch all axios errors
- Return standardized RPCResponse with result: 500
- Error details in response field

### SDK vs Node Communication Comparison

#### Similarities
✅ Same RPCRequest/RPCResponse format
✅ Same authentication headers (identity, signature)
✅ Same algorithm support (ed25519, falcon, ml-dsa)
✅ Same retry patterns (retries + sleep)
✅ Same result code convention (200 = success)

#### Key Differences
❌ SDK is **client-to-single-node** only
❌ SDK uses **axios** (HTTP client library)
❌ SDK has **no peer-to-peer** capabilities
❌ SDK has **no parallel broadcast** to multiple nodes
❌ SDK has **no consensus participation**

### What TCP Protocol Must Preserve for SDK Compatibility

#### 1. HTTP-to-TCP Bridge Layer
The SDK will continue using HTTP/axios, so nodes must support:
- **Option A**: Dual protocol (HTTP + TCP) during migration
- **Option B**: Local HTTP-to-TCP proxy on each node
- **Option C**: SDK update to native TCP client (breaking change)

**Recommendation**: Option A (dual protocol) for backward compatibility

#### 2. Message Format Preservation
- RPCRequest/RPCResponse structures must remain identical
- Authentication header mapping to TCP message fields
- Result code semantics must be preserved

#### 3. NodeCall Compatibility
All SDK query methods rely on nodeCall mechanism:
- Must preserve nodeCall RPC method
- Submethod routing (message field) must work
- Response format must match exactly

### SDK-Specific Communication NOT to Replace

The following SDK communications are **external** and should remain HTTP:
- **Rubic Bridge API**: axios calls to Rubic service (external)
- **Web2 Proxy**: HTTP/HTTPS proxy to external sites
- **DAHR**: Decentralized authenticated HTTP requests (user-facing)

### SDK Files Examined

**Core Communication:**
- `/websdk/demosclass.ts` - Main Demos class with axios calls
- `/websdk/demos.ts` - Global instance export
- `/websdk/DemosTransactions.ts` - Transaction helpers
- `/websdk/Web2Calls.ts` - Web2 integration

**Communication Types:**
- `/types/communication/rpc.ts` - RPCRequest/RPCResponse types
- `/types/communication/demosWork.ts` - DemosWork types

**Tests:**
- `/tests/communication/demos.spec.ts` - Communication tests

### Inter-Node vs Client-Node Communication Summary

**Inter-Node (TO REPLACE WITH TCP):**
- Peer.call() / Peer.longCall() 
- Consensus broadcasts
- Mempool synchronization
- Peerlist gossiping
- Secretary coordination
- GCR synchronization

**Client-Node (KEEP AS HTTP for now):**
- SDK demos.rpcCall()
- SDK demos.call()
- SDK demos.nodeCall() methods
- Browser-to-node communication
- All SDK transaction methods

**External (KEEP AS HTTP always):**
- Rubic bridge API
- Web2 proxy requests
- External blockchain RPCs (Aptos, Solana, etc.)

### TCP Protocol Client Compatibility Requirements

1. **Maintain HTTP endpoint** for SDK clients during migration
2. **Identical RPCRequest/RPCResponse** format over both protocols
3. **Same authentication mechanism** (headers → TCP message fields)
4. **Same nodeCall routing** logic
5. **Backward compatible** result codes and error messages
6. **Optional**: TCP SDK client for future native TCP support

### Performance Comparison Targets

**Current SDK → Node:**
- Connection test: 1 axios.get request
- Single query: 1 axios.post request
- Transaction: 2 axios.post requests (confirm + broadcast)
- Retry: 250ms sleep between attempts

**Future TCP Client:**
- Connection: TCP handshake + hello_peer
- Single query: 1 TCP message exchange
- Transaction: 2 TCP message exchanges
- Retry: Same 250ms sleep logic
- **Target**: <100ms latency improvement per request