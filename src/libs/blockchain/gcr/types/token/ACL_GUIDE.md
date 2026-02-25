# Token Access Control List (ACL) Guide

## Overview

The Token ACL system provides granular permission management for GCRv2 tokens on the Demos Network. It allows token owners to delegate specific capabilities to other addresses without transferring full ownership.

## Permission Hierarchy

```
                    +-------------------+
                    |      Owner        |
                    | (All Permissions) |
                    +-------------------+
                            |
                            | implicit
                            v
                    +-------------------+
                    |   ACL Entries     |
                    | (Explicit Grants) |
                    +-------------------+
                            |
                    +-------+-------+
                    |       |       |
                    v       v       v
                 Minter  Admin  Operator
                  Role    Role    Role
```

**Key Principles:**
- **Owner** always has ALL permissions implicitly (no ACL entry needed)
- **Other addresses** require explicit ACL entries to gain permissions
- **Empty ACL** = only owner can perform protected operations

## Available Permissions

| Permission | Value | Description |
|------------|-------|-------------|
| `canMint` | `"canMint"` | Allows minting new tokens, increasing total supply |
| `canBurn` | `"canBurn"` | Allows burning tokens from any address (not just own) |
| `canUpgrade` | `"canUpgrade"` | Allows upgrading the token script code |
| `canPause` | `"canPause"` | Allows pausing/unpausing token operations |
| `canTransferOwnership` | `"canTransferOwnership"` | Allows transferring token ownership |
| `canModifyACL` | `"canModifyACL"` | Allows granting/revoking permissions |
| `canExecuteScript` | `"canExecuteScript"` | Allows calling custom script methods |

## Permission Use Cases

### Minter Role
```typescript
// Grant minting permission to a rewards contract
await grantPermission({
  tokenAddress: "0x...",
  grantee: rewardsContractAddress,
  permissions: ["canMint"]
});
```

### Admin Role
```typescript
// Grant admin permissions to a multisig
await grantPermission({
  tokenAddress: "0x...",
  grantee: multisigAddress,
  permissions: ["canMint", "canBurn", "canPause", "canModifyACL"]
});
```

### Operator Role
```typescript
// Grant operator permissions for emergencies
await grantPermission({
  tokenAddress: "0x...",
  grantee: operatorAddress,
  permissions: ["canPause"]
});
```

## API Reference

### Granting Permissions

**SDK:**
```typescript
import { createGrantPermissionPayload } from "@kynesyslabs/demosdk/types";

const payload = createGrantPermissionPayload({
  tokenAddress: "0x...",
  grantee: "0x...",
  permissions: ["canMint", "canPause"]
});
```

**Node GCREdit:**
```typescript
const edit: GCREditTokenGrantPermission = {
  type: "token",
  operation: "grantPermission",
  account: senderAddress,
  tokenAddress: tokenAddress,
  txhash: txHash,
  isRollback: false,
  data: {
    grantee: "0x...",
    permissions: ["canMint"]
  }
};
```

### Revoking Permissions

**SDK:**
```typescript
import { createRevokePermissionPayload } from "@kynesyslabs/demosdk/types";

const payload = createRevokePermissionPayload({
  tokenAddress: "0x...",
  grantee: "0x...",
  permissions: ["canMint"]
});
```

**Node GCREdit:**
```typescript
const edit: GCREditTokenRevokePermission = {
  type: "token",
  operation: "revokePermission",
  account: senderAddress,
  tokenAddress: tokenAddress,
  txhash: txHash,
  isRollback: false,
  data: {
    grantee: "0x...",
    permissions: ["canMint"]
  }
};
```

### Checking Permissions

```typescript
import GCRTokenRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines";

// Check single permission
const canMint = await GCRTokenRoutines.checkPermission(
  tokenAddress,
  userAddress,
  "canMint",
  gcrTokenRepository
);

// Get all permissions for an address
const permissions = await GCRTokenRoutines.getPermissions(
  tokenAddress,
  userAddress,
  gcrTokenRepository
);

// Get full ACL
const acl = await GCRTokenRoutines.getACL(tokenAddress, gcrTokenRepository);
```

## ACL Data Structure

### GCR_Token Entity

```typescript
// In GCR_Token entity
@Column({ type: "jsonb", name: "aclEntries", default: () => "'[]'" })
aclEntries: Array<{
    address: string;       // Grantee address
    permissions: string[]; // Array of permission strings
    grantedAt: number;     // Unix timestamp
    grantedBy: string;     // Grantor address
}>;
```

### Example ACL State

```json
{
  "owner": "0xOwnerAddress...",
  "paused": false,
  "entries": [
    {
      "address": "0xMinterContract...",
      "permissions": ["canMint"],
      "grantedAt": 1700000000,
      "grantedBy": "0xOwnerAddress..."
    },
    {
      "address": "0xAdminMultisig...",
      "permissions": ["canMint", "canBurn", "canPause", "canModifyACL"],
      "grantedAt": 1700000100,
      "grantedBy": "0xOwnerAddress..."
    }
  ]
}
```

## Security Considerations

### Permission Escalation Prevention

1. **canModifyACL** is powerful - only grant to trusted addresses
2. **canTransferOwnership** should be used sparingly
3. Consider using timelock patterns for sensitive operations

### Best Practices

1. **Principle of Least Privilege**: Grant only necessary permissions
2. **Regular Audits**: Periodically review ACL entries
3. **Revoke Promptly**: Remove permissions when no longer needed
4. **Multi-sig for Admin**: Use multisig for high-privilege operations

### Emergency Procedures

```typescript
// Emergency pause by operator
if (hasPermission(token.toAccessControl(), operatorAddress, "canPause")) {
  await pauseToken(tokenAddress);
}

// Revoke compromised address
await revokePermission({
  tokenAddress,
  grantee: compromisedAddress,
  permissions: ["canMint", "canBurn", "canPause", "canModifyACL"]
});
```

## Integration with Scripting System

The ACL system integrates with the token scripting system:

### Script Execution Permission

```typescript
// Custom methods require canExecuteScript
if (!hasPermission(accessControl, caller, "canExecuteScript")) {
  // Only owner and addresses with canExecuteScript can call custom methods
}
```

### Hook Execution

Hooks execute for all operations but may check permissions internally:

```typescript
// In beforeMint hook
function beforeMint(context) {
  // ACL check is done by the protocol before hook execution
  // Hook can add additional business logic
  return { allow: true, mutations: [] };
}
```

### Script Upgrade

```typescript
// Requires canUpgrade permission
if (!hasPermission(accessControl, caller, "canUpgrade")) {
  throw new Error("No upgrade permission");
}
```

## Related Files

- `src/libs/blockchain/gcr/types/token/TokenPermissions.ts` - Permission constants
- `src/libs/blockchain/gcr/types/token/TokenTypes.ts` - Type definitions
- `src/libs/blockchain/gcr/types/token/GCREditToken.ts` - GCREdit types
- `src/libs/blockchain/gcr/gcr_routines/GCRTokenRoutines.ts` - ACL handlers
- `src/model/entities/GCRv2/GCR_Token.ts` - Entity definition
- `../sdks/src/types/token/` - SDK types

## Changelog

- **Phase 4.2**: Added dedicated grantPermission/revokePermission operations
- **Phase 3.x**: Added canExecuteScript permission for script execution
- **Phase 1.x**: Initial ACL implementation with updateACL operation
