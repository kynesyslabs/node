# OmniProtocol TLS/SSL Guide

Complete guide to enabling and using TLS encryption for OmniProtocol.

## Quick Start

### 1. Enable TLS in Environment

Add to your `.env` file:

```bash
# Enable OmniProtocol server
OMNI_ENABLED=true
OMNI_PORT=3001

# Enable TLS encryption
OMNI_TLS_ENABLED=true
OMNI_TLS_MODE=self-signed
OMNI_TLS_MIN_VERSION=TLSv1.3
```

### 2. Start Node

```bash
npm start
```

The node will automatically:
- Generate a self-signed certificate (first time)
- Store it in `./certs/node-cert.pem` and `./certs/node-key.pem`
- Start TLS server on port 3001

### 3. Verify TLS

Check logs for:
```
[TLS] Generating self-signed certificate...
[TLS] Certificate generated successfully
[TLSServer] 🔒 Listening on 0.0.0.0:3001 (TLS TLSv1.3)
```

## Environment Variables

### Required

- **OMNI_TLS_ENABLED** - Enable TLS encryption
  - Values: `true` or `false`
  - Default: `false`

### Optional

- **OMNI_TLS_MODE** - Certificate mode
  - Values: `self-signed` or `ca`
  - Default: `self-signed`

- **OMNI_CERT_PATH** - Path to certificate file
  - Default: `./certs/node-cert.pem`
  - Auto-generated if doesn't exist

- **OMNI_KEY_PATH** - Path to private key file
  - Default: `./certs/node-key.pem`
  - Auto-generated if doesn't exist

- **OMNI_CA_PATH** - Path to CA certificate (for CA mode)
  - Default: none
  - Required only for `ca` mode

- **OMNI_TLS_MIN_VERSION** - Minimum TLS version
  - Values: `TLSv1.2` or `TLSv1.3`
  - Default: `TLSv1.3`
  - Recommendation: Use TLSv1.3 for better security

## Certificate Modes

### Self-Signed Mode (Default)

Each node generates its own certificate. Security relies on certificate pinning.

**Pros:**
- No CA infrastructure needed
- Quick setup
- Perfect for closed networks

**Cons:**
- Manual certificate management
- Need to exchange fingerprints
- Not suitable for public networks

**Setup:**
```bash
OMNI_TLS_MODE=self-signed
```

Certificates are auto-generated on first start.

### CA Mode (Production)

Use a Certificate Authority to sign certificates.

**Pros:**
- Standard PKI infrastructure
- Automatic trust chain
- Suitable for public networks

**Cons:**
- Requires CA setup
- More complex configuration

**Setup:**
```bash
OMNI_TLS_MODE=ca
OMNI_CERT_PATH=./certs/node-cert.pem
OMNI_KEY_PATH=./certs/node-key.pem
OMNI_CA_PATH=./certs/ca.pem
```

## Certificate Management

### Manual Certificate Generation

To generate certificates manually:

```bash
# Create certs directory
mkdir -p certs

# Generate private key
openssl genrsa -out certs/node-key.pem 2048

# Generate self-signed certificate (valid for 1 year)
openssl req -new -x509 \
  -key certs/node-key.pem \
  -out certs/node-cert.pem \
  -days 365 \
  -subj "/CN=omni-node/O=DemosNetwork/C=US"

# Set proper permissions
chmod 600 certs/node-key.pem
chmod 644 certs/node-cert.pem
```

### Certificate Fingerprinting

Get certificate fingerprint for pinning:

```bash
openssl x509 -in certs/node-cert.pem -noout -fingerprint -sha256
```

Output:
```
SHA256 Fingerprint=AB:CD:EF:01:23:45:67:89:...
```

### Certificate Expiry

Check when certificate expires:

```bash
openssl x509 -in certs/node-cert.pem -noout -enddate
```

The node logs warnings when certificate expires in <30 days:
```
[TLS] ⚠️  Certificate expires in 25 days - consider renewal
```

### Certificate Renewal

To renew an expiring certificate:

```bash
# Backup old certificate
mv certs/node-cert.pem certs/node-cert.pem.bak
mv certs/node-key.pem certs/node-key.pem.bak

# Generate new certificate
# (use same command as manual generation above)

# Restart node
npm restart
```

## Connection Strings

### Plain TCP
```
tcp://host:3001
```

### TLS Encrypted
```
tls://host:3001
```
or
```
tcps://host:3001
```

Both formats work identically.

## Security

### Current Security Features

✅ TLS 1.2/1.3 encryption
✅ Self-signed certificate support
✅ Certificate fingerprint pinning
✅ Strong cipher suites
✅ Client certificate authentication

### Cipher Suites (Default)

Only strong, modern ciphers are allowed:
- `ECDHE-ECDSA-AES256-GCM-SHA384`
- `ECDHE-RSA-AES256-GCM-SHA384`
- `ECDHE-ECDSA-CHACHA20-POLY1305`
- `ECDHE-RSA-CHACHA20-POLY1305`
- `ECDHE-ECDSA-AES128-GCM-SHA256`
- `ECDHE-RSA-AES128-GCM-SHA256`

### Certificate Pinning

In self-signed mode, pin peer certificates by fingerprint:

```typescript
// In your code
import { TLSServer } from "./libs/omniprotocol/server/TLSServer"

const server = new TLSServer({ /* config */ })
await server.start()

// Add trusted peer fingerprints
server.addTrustedFingerprint(
    "peer-identity-1",
    "SHA256:AB:CD:EF:01:23:45:67:89:..."
)
```

### Security Recommendations

**For Development:**
- Use self-signed mode
- Test on localhost only
- Don't expose to public network

**For Production:**
- Use CA mode with valid certificates
- Enable certificate pinning
- Monitor certificate expiry
- Use TLSv1.3 only
- Place behind firewall/VPN

## Troubleshooting

### Certificate Not Found

**Error:**
```
Certificate not found: ./certs/node-cert.pem
```

**Solution:**
Let the node auto-generate, or create manually (see Certificate Generation above).

### Certificate Verification Failed

**Error:**
```
[TLSConnection] Certificate fingerprint mismatch
```

**Cause:** Peer's certificate fingerprint doesn't match expected value.

**Solution:**
1. Get peer's actual fingerprint from logs
2. Update trusted fingerprints list
3. Verify you're connecting to the correct peer

### TLS Handshake Failed

**Error:**
```
[TLSConnection] Connection error: SSL routines::tlsv1 alert protocol version
```

**Cause:** TLS version mismatch.

**Solution:**
Ensure both nodes use compatible TLS versions:
```bash
OMNI_TLS_MIN_VERSION=TLSv1.2  # More compatible
```

### Connection Timeout

**Error:**
```
TLS connection timeout after 5000ms
```

**Possible causes:**
1. Port blocked by firewall
2. Wrong host/port
3. Server not running
4. Network issues

**Solution:**
```bash
# Check if port is open
nc -zv host 3001

# Check firewall
sudo ufw status
sudo ufw allow 3001/tcp

# Verify server is listening
netstat -an | grep 3001
```

## Performance

### TLS Overhead

- **Handshake:** +20-50ms per connection
- **Encryption:** +5-10% CPU overhead
- **Memory:** +1-2KB per connection

### Optimization Tips

1. **Connection Reuse:** Keep connections alive to avoid repeated handshakes
2. **Hardware Acceleration:** Use CPU with AES-NI instructions
3. **TLS Session Resumption:** Reduce handshake cost (automatic)

## Migration Path

### Phase 1: Plain TCP (Current)
```bash
OMNI_ENABLED=true
OMNI_TLS_ENABLED=false
```

All connections use plain TCP.

### Phase 2: Optional TLS
```bash
OMNI_ENABLED=true
OMNI_TLS_ENABLED=true
```

Server accepts both TCP and TLS connections. Clients choose based on connection string.

### Phase 3: TLS Only
```bash
OMNI_ENABLED=true
OMNI_TLS_ENABLED=true
OMNI_REJECT_PLAIN_TCP=true  # Future feature
```

Only TLS connections allowed.

## Examples

### Basic Setup (Self-Signed)

```bash
# .env
OMNI_ENABLED=true
OMNI_TLS_ENABLED=true
OMNI_TLS_MODE=self-signed
```

```bash
# Start node
npm start
```

### Production Setup (CA Certificates)

```bash
# .env
OMNI_ENABLED=true
OMNI_TLS_ENABLED=true
OMNI_TLS_MODE=ca
OMNI_CERT_PATH=/etc/ssl/certs/node.pem
OMNI_KEY_PATH=/etc/ssl/private/node.key
OMNI_CA_PATH=/etc/ssl/certs/ca.pem
OMNI_TLS_MIN_VERSION=TLSv1.3
```

### Docker Setup

```dockerfile
FROM node:18

# Copy certificates
COPY certs/ /app/certs/

# Set environment
ENV OMNI_ENABLED=true
ENV OMNI_TLS_ENABLED=true
ENV OMNI_CERT_PATH=/app/certs/node-cert.pem
ENV OMNI_KEY_PATH=/app/certs/node-key.pem

# Expose TLS port
EXPOSE 3001

CMD ["npm", "start"]
```

## Monitoring

### Check TLS Status

```bash
# View certificate info
openssl s_client -connect localhost:3001 -showcerts

# Test TLS connection
openssl s_client -connect localhost:3001 \
  -cert certs/node-cert.pem \
  -key certs/node-key.pem
```

### Logs to Monitor

```
[TLS] Certificate valid for 335 more days
[TLSServer] 🔒 Listening on 0.0.0.0:3001 (TLS TLSv1.3)
[TLSServer] New TLS connection from 192.168.1.100:54321
[TLSServer] TLS TLSv1.3 with TLS_AES_256_GCM_SHA384
[TLSServer] Verified trusted certificate: SHA256:ABCD...
```

### Metrics

Track these metrics:
- TLS handshake time
- Cipher suite usage
- Certificate expiry days
- Failed handshakes
- Untrusted certificate attempts

## Support

For issues:
- Implementation plan: `OmniProtocol/10_TLS_IMPLEMENTATION_PLAN.md`
- Server implementation: `src/libs/omniprotocol/server/TLSServer.ts`
- Client implementation: `src/libs/omniprotocol/transport/TLSConnection.ts`
- Certificate utilities: `src/libs/omniprotocol/tls/certificates.ts`

---

**Status:** Production-ready for closed networks with self-signed certificates
**Recommendation:** Use behind firewall/VPN until rate limiting is implemented
