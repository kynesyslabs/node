# OmniProtocol TLS/SSL Implementation Plan

## Overview

Add TLS encryption to OmniProtocol for secure node-to-node communication.

## Design Decisions

### 1. TLS Layer Architecture

```
┌─────────────────────────────────────────────────┐
│  Application Layer (OmniProtocol)               │
├─────────────────────────────────────────────────┤
│  TLS Layer (Node's tls module)                  │
│  - Certificate verification                     │
│  - Encryption (TLS 1.2/1.3)                     │
│  - Handshake                                    │
├─────────────────────────────────────────────────┤
│  TCP Layer (net module)                         │
└─────────────────────────────────────────────────┘
```

### 2. Connection String Format

- **Plain TCP**: `tcp://host:port`
- **TLS**: `tls://host:port`
- **Auto-detect**: Parse protocol prefix to determine mode

### 3. Certificate Management Options

#### Option A: Self-Signed Certificates (Simple)
- Each node generates its own certificate
- Certificate pinning using public key fingerprints
- No CA required
- Good for closed networks

#### Option B: CA-Signed Certificates (Production)
- Use existing CA infrastructure
- Proper certificate chain validation
- Industry standard approach
- Better for open networks

**Recommendation**: Start with Option A (self-signed), add Option B later

### 4. Certificate Storage

```
node/
├── certs/
│   ├── node-key.pem       # Private key
│   ├── node-cert.pem      # Certificate
│   ├── node-ca.pem        # CA cert (optional)
│   └── trusted/           # Trusted peer certs
│       ├── peer1.pem
│       └── peer2.pem
```

### 5. TLS Configuration

```typescript
interface TLSConfig {
    enabled: boolean              // Enable TLS
    mode: 'self-signed' | 'ca'   // Certificate mode
    certPath: string             // Path to certificate
    keyPath: string              // Path to private key
    caPath?: string              // Path to CA cert
    rejectUnauthorized: boolean  // Verify peer certs
    minVersion: 'TLSv1.2' | 'TLSv1.3'
    ciphers?: string             // Allowed ciphers
    requestCert: boolean         // Require client certs
    trustedFingerprints?: string[] // Pinned cert fingerprints
}
```

## Implementation Steps

### Step 1: TLS Certificate Utilities

**File**: `src/libs/omniprotocol/tls/certificates.ts`

```typescript
- generateSelfSignedCert() - Generate node certificate
- loadCertificate() - Load from file
- getCertificateFingerprint() - Get SHA256 fingerprint
- verifyCertificate() - Validate certificate
- saveCertificate() - Save to file
```

### Step 2: TLS Server Wrapper

**File**: `src/libs/omniprotocol/server/TLSServer.ts`

```typescript
class TLSServer extends OmniProtocolServer {
    private tlsServer: tls.Server

    async start() {
        const options = {
            key: fs.readFileSync(tlsConfig.keyPath),
            cert: fs.readFileSync(tlsConfig.certPath),
            requestCert: true,
            rejectUnauthorized: false, // Custom verification
        }

        this.tlsServer = tls.createServer(options, (socket) => {
            // Verify client certificate
            if (!this.verifyCertificate(socket)) {
                socket.destroy()
                return
            }

            // Pass to existing connection handler
            this.handleNewConnection(socket)
        })

        this.tlsServer.listen(...)
    }
}
```

### Step 3: TLS Client Wrapper

**File**: `src/libs/omniprotocol/transport/TLSConnection.ts`

```typescript
class TLSConnection extends PeerConnection {
    async connect(options: ConnectionOptions) {
        const tlsOptions = {
            host: this.parsedConnection.host,
            port: this.parsedConnection.port,
            key: fs.readFileSync(tlsConfig.keyPath),
            cert: fs.readFileSync(tlsConfig.certPath),
            rejectUnauthorized: false, // Custom verification
        }

        this.socket = tls.connect(tlsOptions, () => {
            // Verify server certificate
            if (!this.verifyCertificate()) {
                this.socket.destroy()
                throw new Error('Certificate verification failed')
            }

            // Continue with hello_peer handshake
            this.setState("AUTHENTICATING")
        })
    }
}
```

### Step 4: Connection Factory

**File**: `src/libs/omniprotocol/transport/ConnectionFactory.ts`

```typescript
class ConnectionFactory {
    static createConnection(
        peerIdentity: string,
        connectionString: string
    ): PeerConnection {
        const parsed = parseConnectionString(connectionString)

        if (parsed.protocol === 'tls') {
            return new TLSConnection(peerIdentity, connectionString)
        } else {
            return new PeerConnection(peerIdentity, connectionString)
        }
    }
}
```

### Step 5: Certificate Initialization

**File**: `src/libs/omniprotocol/tls/initialize.ts`

```typescript
async function initializeTLSCertificates() {
    const certDir = path.join(process.cwd(), 'certs')
    const certPath = path.join(certDir, 'node-cert.pem')
    const keyPath = path.join(certDir, 'node-key.pem')

    // Create cert directory
    await fs.promises.mkdir(certDir, { recursive: true })

    // Check if certificate exists
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        console.log('[TLS] Generating self-signed certificate...')
        await generateSelfSignedCert(certPath, keyPath)
        console.log('[TLS] Certificate generated')
    } else {
        console.log('[TLS] Using existing certificate')
    }

    return { certPath, keyPath }
}
```

### Step 6: Startup Integration

Update `src/index.ts`:

```typescript
// Initialize TLS certificates if enabled
if (indexState.OMNI_TLS_ENABLED) {
    const { certPath, keyPath } = await initializeTLSCertificates()
    indexState.OMNI_CERT_PATH = certPath
    indexState.OMNI_KEY_PATH = keyPath
}

// Start server with TLS
const omniServer = await startOmniProtocolServer({
    enabled: true,
    port: indexState.OMNI_PORT,
    tls: {
        enabled: indexState.OMNI_TLS_ENABLED,
        certPath: indexState.OMNI_CERT_PATH,
        keyPath: indexState.OMNI_KEY_PATH,
    }
})
```

## Environment Variables

```bash
# TLS Configuration
OMNI_TLS_ENABLED=true           # Enable TLS
OMNI_TLS_MODE=self-signed       # self-signed or ca
OMNI_CERT_PATH=./certs/node-cert.pem
OMNI_KEY_PATH=./certs/node-key.pem
OMNI_CA_PATH=./certs/ca.pem     # Optional
OMNI_TLS_MIN_VERSION=TLSv1.3    # Minimum TLS version
```

## Security Considerations

### Certificate Pinning (Self-Signed Mode)

Store trusted peer fingerprints:

```typescript
const trustedPeers = {
    'peer-identity-1': 'SHA256:abcd1234...',
    'peer-identity-2': 'SHA256:efgh5678...',
}

function verifyCertificate(socket: tls.TLSSocket): boolean {
    const cert = socket.getPeerCertificate()
    const fingerprint = cert.fingerprint256
    const peerIdentity = extractIdentityFromCert(cert)

    return trustedPeers[peerIdentity] === fingerprint
}
```

### Cipher Suites

Use strong ciphers only:

```typescript
const ciphers = [
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
].join(':')
```

### Certificate Rotation

```typescript
// Monitor certificate expiry
function checkCertExpiry(certPath: string) {
    const cert = forge.pki.certificateFromPem(
        fs.readFileSync(certPath, 'utf8')
    )

    const daysUntilExpiry = (cert.validity.notAfter - new Date()) / (1000 * 60 * 60 * 24)

    if (daysUntilExpiry < 30) {
        console.warn(`[TLS] Certificate expires in ${daysUntilExpiry} days`)
    }
}
```

## Migration Path

### Phase 1: TCP Only (Current)
- Plain TCP connections
- No encryption

### Phase 2: Optional TLS
- Support both `tcp://` and `tls://`
- Node advertises supported protocols
- Clients choose based on server capability

### Phase 3: TLS Preferred
- Try TLS first, fall back to TCP
- Log warning for unencrypted connections

### Phase 4: TLS Only
- Reject non-TLS connections
- Full encryption enforcement

## Testing Strategy

### Unit Tests
```typescript
describe('TLS Certificate Generation', () => {
    it('should generate valid self-signed certificate', async () => {
        const { certPath, keyPath } = await generateSelfSignedCert()
        expect(fs.existsSync(certPath)).toBe(true)
        expect(fs.existsSync(keyPath)).toBe(true)
    })

    it('should calculate correct fingerprint', () => {
        const fingerprint = getCertificateFingerprint(certPath)
        expect(fingerprint).toMatch(/^SHA256:[0-9A-F:]+$/)
    })
})

describe('TLS Connection', () => {
    it('should establish TLS connection', async () => {
        const server = new TLSServer({ port: 9999 })
        await server.start()

        const client = new TLSConnection('peer1', 'tls://localhost:9999')
        await client.connect()

        expect(client.getState()).toBe('READY')
    })

    it('should reject invalid certificate', async () => {
        // Test with wrong cert
        await expect(client.connect()).rejects.toThrow('Certificate verification failed')
    })
})
```

### Integration Test
```typescript
describe('TLS End-to-End', () => {
    it('should send authenticated message over TLS', async () => {
        // Start TLS server
        // Connect TLS client
        // Send authenticated message
        // Verify response
        // Check encryption was used
    })
})
```

## Performance Impact

### Overhead
- TLS handshake: +20-50ms per connection
- Encryption: +5-10% CPU overhead
- Memory: +1-2KB per connection

### Optimization
- Session resumption (reduce handshake cost)
- Hardware acceleration (AES-NI)
- Connection pooling (reuse TLS sessions)

## Rollout Plan

1. **Week 1**: Implement certificate utilities and TLS wrappers
2. **Week 2**: Integration and testing
3. **Week 3**: Documentation and deployment guide
4. **Week 4**: Gradual rollout (10% → 50% → 100%)

## Documentation Deliverables

- TLS setup guide
- Certificate management guide
- Troubleshooting guide
- Security best practices
- Migration guide (TCP → TLS)

---

**Status**: Ready to implement
**Estimated Time**: 4-6 hours
**Priority**: High (security feature)
