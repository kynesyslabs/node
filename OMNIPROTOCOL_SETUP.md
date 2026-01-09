# OmniProtocol Server Setup Guide

## Quick Start

The OmniProtocol TCP server is now integrated into the node startup. To enable it, simply set the environment variable:

```bash
export OMNI_ENABLED=true
```

Then start your node normally:

```bash
npm start
```

## Environment Variables

### Required

- **OMNI_ENABLED** - Enable/disable OmniProtocol server
  - Values: `true` or `false`
  - Default: `false` (disabled)
  - Example: `OMNI_ENABLED=true`

### Optional

- **OMNI_PORT** - TCP port for OmniProtocol server
  - Default: `HTTP_PORT + 1` (e.g., if HTTP is 3000, OMNI will be 3001)
  - Example: `OMNI_PORT=3001`

## Configuration Examples

### .env file

Add to your `.env` file:

```bash
# OmniProtocol TCP Server
OMNI_ENABLED=true
OMNI_PORT=3001
```

### Command line

```bash
OMNI_ENABLED=true OMNI_PORT=3001 npm start
```

### Docker

```dockerfile
ENV OMNI_ENABLED=true
ENV OMNI_PORT=3001
```

## Startup Output

When enabled, you'll see:

```
[MAIN] ✅ OmniProtocol server started on port 3001
```

When disabled:

```
[MAIN] OmniProtocol server disabled (set OMNI_ENABLED=true to enable)
```

## Verification

### Check if server is listening

```bash
# Check if port is open
netstat -an | grep 3001

# Or use lsof
lsof -i :3001
```

### Test connection

```bash
# Simple TCP connection test
nc -zv localhost 3001
```

### View logs

The OmniProtocol server logs to console with prefix `[OmniProtocol]`:

```
[OmniProtocol] ✅ Server listening on port 3001
[OmniProtocol] 📥 Connection accepted from 192.168.1.100:54321
[OmniProtocol] ❌ Connection rejected from 192.168.1.200:12345: capacity
```

## Graceful Shutdown

The server automatically shuts down gracefully when you stop the node:

```bash
# Press Ctrl+C or send SIGTERM
kill -TERM <node_pid>
```

Output:
```
[SHUTDOWN] Received SIGINT, shutting down gracefully...
[SHUTDOWN] Stopping OmniProtocol server...
[OmniProtocol] Stopping server...
[OmniProtocol] Closing 5 connections...
[OmniProtocol] Server stopped
[SHUTDOWN] Cleanup complete, exiting...
```

## Troubleshooting

### Server fails to start

**Error**: `Error: listen EADDRINUSE: address already in use :::3001`

**Solution**: Port is already in use. Either:
1. Change OMNI_PORT to a different port
2. Stop the process using port 3001

**Check what's using the port**:
```bash
lsof -i :3001
```

### No connections accepted

**Check firewall**:
```bash
# Ubuntu/Debian
sudo ufw allow 3001/tcp

# CentOS/RHEL
sudo firewall-cmd --add-port=3001/tcp --permanent
sudo firewall-cmd --reload
```

### Authentication failures

If you see authentication errors in logs:

```
[OmniProtocol] Authentication failed for opcode execute: Signature verification failed
```

**Possible causes**:
- Client using wrong private key
- Timestamp skew >5 minutes (check system time)
- Corrupted message in transit

**Fix**:
1. Verify client keys match peer identity
2. Sync system time with NTP
3. Check network for packet corruption

## Performance Tuning

### Connection Limits

Default: 1000 concurrent connections

To increase, modify in `src/index.ts`:

```typescript
const omniServer = await startOmniProtocolServer({
    enabled: true,
    port: indexState.OMNI_PORT,
    maxConnections: 5000, // Increase limit
})
```

### Timeouts

Default settings:
- Auth timeout: 5 seconds
- Idle timeout: 10 minutes (600,000ms)

To adjust:

```typescript
const omniServer = await startOmniProtocolServer({
    enabled: true,
    port: indexState.OMNI_PORT,
    authTimeout: 10000,      // 10 seconds
    connectionTimeout: 300000, // 5 minutes
})
```

### System Limits

For high connection counts (>1000), increase system limits:

```bash
# Increase file descriptor limit
ulimit -n 65536

# Make permanent in /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536

# TCP tuning for Linux
sudo sysctl -w net.core.somaxconn=4096
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=8192
```

## Migration Strategy

### Phase 1: HTTP Only (Default)

Node runs with HTTP only, OmniProtocol disabled:

```bash
OMNI_ENABLED=false npm start
```

### Phase 2: Dual Protocol (Testing)

Node runs both HTTP and OmniProtocol:

```bash
OMNI_ENABLED=true npm start
```

- HTTP continues to work normally
- OmniProtocol available for testing
- Automatic fallback to HTTP if OmniProtocol fails

### Phase 3: OmniProtocol Preferred (Production)

Configure PeerOmniAdapter to prefer OmniProtocol:

```typescript
// In your code
import { PeerOmniAdapter } from "./libs/omniprotocol/integration/peerAdapter"

const adapter = new PeerOmniAdapter({
    config: {
        migration: {
            mode: "OMNI_PREFERRED", // Use OmniProtocol when available
            omniPeers: new Set(["peer-identity-1", "peer-identity-2"])
        }
    }
})
```

## Security Considerations

### Current Status

✅ Ed25519 authentication
✅ Timestamp replay protection (±5 minutes)
✅ Connection limits
✅ Per-handler auth requirements

⚠️ **Missing** (not production-ready yet):
- ❌ Rate limiting (DoS vulnerable)
- ❌ TLS/SSL (plain TCP)
- ❌ Per-IP connection limits

### Recommendations

**For testing/development**:
- Enable on localhost only
- Use behind firewall/VPN
- Monitor connection counts

**For production** (once rate limiting is added):
- Enable rate limiting
- Use behind reverse proxy
- Monitor for abuse patterns
- Consider TLS/SSL for public networks

## Next Steps

1. **Enable the server**: Set `OMNI_ENABLED=true`
2. **Start the node**: `npm start`
3. **Verify startup**: Check logs for "OmniProtocol server started"
4. **Test locally**: Connect from another node on same network
5. **Monitor**: Watch logs for connections and errors

## Support

For issues or questions:
- Check implementation status: `src/libs/omniprotocol/IMPLEMENTATION_STATUS.md`
- View specifications: `OmniProtocol/08_TCP_SERVER_IMPLEMENTATION.md`
- Authentication details: `OmniProtocol/09_AUTHENTICATION_IMPLEMENTATION.md`
