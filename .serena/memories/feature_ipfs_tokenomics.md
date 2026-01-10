# IPFS Tokenomics Specification

## Pricing Model

### Regular Accounts
| Size Range | Cost (DEM) | Formula |
|------------|------------|---------|
| 0 - 100MB | 1 DEM | Minimum |
| 100MB+ | N DEM | ceil(size / 100MB) |

### Genesis Accounts
| Usage | Cost (DEM) |
|-------|------------|
| First 1GB | **FREE** |
| After 1GB | 1 DEM per 1GB |

## Fee Distribution (MVP)
| Recipient | Share |
|-----------|-------|
| Hosting RPC | 100% |

## Future Target
| Recipient | Share |
|-----------|-------|
| Hosting RPC | 70% |
| Treasury | 20% |
| Consensus | 10% |

## Configuration Constants
```typescript
const IPFS_PRICING_CONFIG = {
  REGULAR_MIN_COST: 1n,
  REGULAR_BYTES_PER_UNIT: 100 * 1024 * 1024,  // 100 MB
  GENESIS_FREE_BYTES: 1024 * 1024 * 1024,      // 1 GB
  HOST_SHARE_PERCENT: 100,
}
```

## Key File
- `src/libs/blockchain/routines/ipfsTokenomics.ts`