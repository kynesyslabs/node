# OmniProtocol - HTTP Endpoint Analysis

## Server RPC Endpoints (server_rpc.ts)

### GET Endpoints (Read-Only, Info Retrieval)
1. **GET /** - Health check, returns "Hello World" with client IP
2. **GET /info** - Node information (version, version_name, extended info)
3. **GET /version** - Version string only
4. **GET /publickey** - Node's public key (hex format)
5. **GET /connectionstring** - Node's connection string for peers
6. **GET /peerlist** - List of all known peers
7. **GET /public_logs** - Public logs from logger
8. **GET /diagnostics** - Diagnostic information
9. **GET /mcp** - MCP server status (enabled, transport, status)
10. **GET /genesis** - Genesis block and genesis data
11. **GET /rate-limit/stats** - Rate limiter statistics

### POST Endpoints (RPC Methods with Authentication)
**Main RPC Endpoint: POST /**

#### RPC Methods (via POST / with method parameter):

**No Authentication Required:**
- `nodeCall` - Node-to-node calls (ping, getPeerlist, etc.)

**Authentication Required (signature + identity headers):**
1. `ping` - Simple ping/pong
2. `execute` - Execute bundle content (transactions)
3. `nativeBridge` - Native bridge operations
4. `hello_peer` - Peer handshake and status exchange
5. `mempool` - Mempool merging between nodes
6. `peerlist` - Peerlist merging
7. `auth` - Authentication message handling
8. `login_request` - Browser login request
9. `login_response` - Browser login response
10. `consensus_routine` - Consensus mechanism messages (PoRBFTv2)
11. `gcr_routine` - GCR (Global Consensus Registry) routines
12. `bridge` - Bridge operations
13. `web2ProxyRequest` - Web2 proxy request handling

**Protected Endpoints (require SUDO_PUBKEY):**
- `rate-limit/unblock` - Unblock IP addresses
- `getCampaignData` - Get campaign data
- `awardPoints` - Award points to users

## Peer-to-Peer Communication Patterns (Peer.ts)

### RPC Call Pattern
- **Method**: HTTP POST to peer's connection string
- **Headers**:
  - `Content-Type: application/json`
  - `identity: <algorithm>:<hex_publickey>` (if authenticated)
  - `signature: <hex_signature>` (if authenticated)
- **Body**: RPCRequest JSON
  ```json
  {
    "method": "string",
    "params": [...]
  }
  ```
- **Response**: RPCResponse JSON
  ```json
  {
    "result": number,
    "response": any,
    "require_reply": boolean,
    "extra": any
  }
  ```

### Peer Operations
1. **connect()** - Tests connection with ping via nodeCall
2. **call()** - Makes authenticated RPC call with signature headers
3. **longCall()** - Retry mechanism for failed calls
4. **authenticatedCall()** - Adds signature to request
5. **fetch()** - Simple HTTP GET for endpoints
6. **getInfo()** - Fetches /info endpoint
7. **multiCall()** - Parallel calls to multiple peers

### Authentication Mechanism
- Algorithm support: ed25519, falcon, ml-dsa
- Identity format: `<algorithm>:<hex_publickey>`
- Signature: Sign the hex public key with private key
- Headers: Both identity and signature sent in HTTP headers

## Consensus Communication (from search results)

### Consensus Routine Messages
- Secretary manager coordination
- Candidate block formation
- Shard management status updates
- Validator consensus messages

## Key Communication Patterns to Replicate

### 1. Request-Response Pattern
- Most RPC methods follow synchronous request-response
- Timeout: 3000ms default
- Result codes: HTTP-like (200 = success, 400/500/501 = errors)

### 2. Fire-and-Forget Pattern
- Some consensus messages don't require immediate response
- `require_reply: false` in RPCResponse

### 3. Pub/Sub Patterns
- Mempool propagation
- Peerlist gossiping
- Consensus message broadcasting

### 4. Peer Discovery Flow
1. Bootstrap with known peers from `demos_peer.json`
2. `hello_peer` handshake exchange
3. Peer status tracking (online, verified, synced)
4. Periodic health checks
5. Offline peer retry mechanism

### 5. Data Structures Exchanged
- **BundleContent** - Transaction bundles
- **HelloPeerRequest** - Peer handshake with sync data
- **AuthMessage** - Authentication messages
- **NodeCall** - Node-to-node calls
- **ConsensusRequest** - Consensus messages
- **BrowserRequest** - Browser/client requests

## Critical HTTP Features to Preserve in TCP

### Authentication & Security
- Signature-based authentication (ed25519/falcon/ml-dsa)
- Identity verification before processing
- Protected endpoints requiring specific public keys
- Rate limiting per IP address

### Connection Management
- Connection string format for peer identification
- Peer online/offline status tracking
- Retry mechanisms with exponential backoff
- Timeout handling (default 3000ms)

### Message Routing
- Method-based routing (similar to HTTP endpoints)
- Parameter validation
- Error response standardization
- Result code convention (200, 400, 500, 501, etc.)

### Performance Features
- Parallel peer calls (multiCall)
- Long-running calls with retries
- Rate limiting (requests per block for identity transactions)
- IP-based request tracking

## TCP Protocol Requirements Derived

### Message Types Needed (Minimum)
Based on analysis, we need at least:
- **Control Messages**: ping, hello_peer, auth
- **Data Sync**: mempool, peerlist, genesis
- **Execution**: execute (transactions), nativeBridge
- **Consensus**: consensus_routine, gcr_routine
- **Query**: nodeCall, info requests
- **Bridge**: bridge operations
- **Admin**: rate-limit control, protected operations

### Message Structure Requirements
1. **Header**: Message type (byte), version, flags, length
2. **Authentication**: Identity, signature (for authenticated messages)
3. **Payload**: Method-specific data
4. **Response**: Result code, data, extra metadata

### Connection Lifecycle
1. **Bootstrap**: Load peer list from file
2. **Discovery**: Hello handshake with sync data exchange
3. **Verification**: Signature validation
4. **Active**: Ongoing communication
5. **Health Check**: Periodic hello_peer messages
6. **Cleanup**: Offline peer detection and retry

### Performance Targets (from HTTP baseline)
- Request timeout: 3000ms (configurable)
- Retry attempts: 3 (with sleep between)
- Rate limit: Configurable per IP, per block
- Parallel calls: Support for batch operations