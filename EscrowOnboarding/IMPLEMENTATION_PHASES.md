# Implementation Phases - Remaining Work

## Completed Phases Summary

✅ **Phase 1: Database Schema** - `escrows` JSONB column added to GCR_Main
✅ **Phase 2: Core Logic** - `GCREscrowRoutines.ts` implemented with deposit/claim/refund operations
✅ **Phase 3: SDK** - Transaction builders and query helpers (completed in SDK repo v2.5.4)

See [STATUS.md](./STATUS.md) for complete implementation status.

---

## Phase 4: RPC Endpoints for Querying Escrows

**Time**: 1-2 hours
**Priority**: Medium
**Status**: PENDING ⏳

### Goals

- Add RPC methods to query escrow state
- Enable frontend to discover claimable escrows
- Provide balance information for specific escrows

### Files to Modify

#### 1. `src/libs/network/endpointHandlers.ts`

**Add new RPC handler functions**:

```typescript
import GCREscrowRoutines from "@/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import { ClaimableEscrow } from "@/model/entities/types/EscrowTypes"

/**
 * RPC: Get escrow balance for a specific social identity
 */
export async function handleGetEscrowBalance(params: {
    platform: string
    username: string
}) {
    const { platform, username } = params

    if (!platform || !username) {
        throw new Error("Missing platform or username")
    }

    const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)
    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    const account = await repo.findOneBy({ pubkey: escrowAddress })

    if (!account || !account.escrows || !account.escrows[escrowAddress]) {
        return {
            escrowAddress,
            exists: false,
            balance: "0",
            deposits: [],
            expiryTimestamp: 0,
            expired: false,
        }
    }

    const escrow = account.escrows[escrowAddress]

    return {
        escrowAddress,
        exists: true,
        balance: escrow.balance.toString(),
        deposits: escrow.deposits.map(d => ({
            from: d.from,
            amount: d.amount.toString(),
            timestamp: d.timestamp,
            message: d.message,
        })),
        expiryTimestamp: escrow.expiryTimestamp,
        expired: Date.now() > escrow.expiryTimestamp,
    }
}

/**
 * RPC: Get all escrows claimable by a Demos address
 */
export async function handleGetClaimableEscrows(params: {
    address: string
}): Promise<ClaimableEscrow[]> {
    const { address } = params

    if (!address) {
        throw new Error("Missing address")
    }

    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    const account = await repo.findOneBy({ pubkey: address })

    if (!account || !account.identities || !account.identities.web2) {
        return []
    }

    const claimable: ClaimableEscrow[] = []

    // Collect all potential escrow addresses and their identity details
    const identityLookups = []
    for (const [platform, identities] of Object.entries(account.identities.web2)) {
        if (!Array.isArray(identities)) continue;

        for (const identity of identities) {
            if (identity.username) {
                const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, identity.username);
                identityLookups.push({ platform, username: identity.username, escrowAddress });
            }
        }
    }

    if (identityLookups.length === 0) {
        return [];
    }

    // Fetch all escrow accounts in a single query
    const escrowAddresses = identityLookups.map(lookup => lookup.escrowAddress);
    const escrowAccounts = await repo.find({ where: { pubkey: In(escrowAddresses) } });

    const escrowAccountMap = new Map(escrowAccounts.map(acc => [acc.pubkey, acc]));

    // Process the results
    for (const lookup of identityLookups) {
        const escrowAccount = escrowAccountMap.get(lookup.escrowAddress);
        if (escrowAccount?.escrows?.[lookup.escrowAddress]) {
            const escrow = escrowAccount.escrows[lookup.escrowAddress];
            claimable.push({
                platform: lookup.platform as "twitter" | "github" | "telegram",
                username: lookup.username,
                balance: escrow.balance.toString(),
                escrowAddress: lookup.escrowAddress,
                deposits: escrow.deposits.map(d => ({
                    from: d.from,
                    amount: d.amount.toString(),
                    timestamp: d.timestamp,
                    message: d.message,
                })),
                expiryTimestamp: escrow.expiryTimestamp,
                expired: Date.now() > escrow.expiryTimestamp,
            });
        }
    }

    return claimable
}

/**
 * RPC: Get all escrows created by a specific address (sender)
 */
export async function handleGetSentEscrows(params: { sender: string }) {
    const { sender } = params

    if (!sender) {
        throw new Error("Missing sender address")
    }

    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    // This query requires a GIN index on the 'escrows' JSONB column for performance.
    // The query finds all GCRMain entities where the 'escrows' object contains at least
    // one deposit from the specified sender.
    const accountsWithSentEscrows = await repo.createQueryBuilder("gcr")
        .where(`gcr.escrows @> :query`, {
            query: JSON.stringify({ deposits: [{ from: sender }] })
        })
        .getMany();

    const sentEscrows = [];

    for (const account of accountsWithSentEscrows) {
        if (!account.escrows) continue;

        for (const [escrowAddr, escrow] of Object.entries(account.escrows)) {
            const senderDeposits = escrow.deposits?.filter(d => d.from === sender) || [];

            if (senderDeposits.length > 0) {
                const totalSent = senderDeposits.reduce((sum, d) => sum + BigInt(d.amount), 0n);

                sentEscrows.push({
                    platform: escrow.claimableBy.platform,
                    username: escrow.claimableBy.username,
                    escrowAddress: escrowAddr,
                    totalSent: totalSent.toString(),
                    deposits: senderDeposits.map(d => ({
                        amount: d.amount.toString(),
                        timestamp: d.timestamp,
                        message: d.message,
                    })),
                    totalEscrowBalance: escrow.balance.toString(),
                    expired: Date.now() > escrow.expiryTimestamp,
                    expiryTimestamp: escrow.expiryTimestamp,
                });
            }
        }
    }

    return sentEscrows
}
```

#### 2. `src/libs/network/server_rpc.ts`

**Register new RPC endpoints** in the method routing switch:

```typescript
// Add to RPC method routing
case "get_escrow_balance":
    return await handleGetEscrowBalance(request.params)

case "get_claimable_escrows":
    return await handleGetClaimableEscrows(request.params)

case "get_sent_escrows":
    return await handleGetSentEscrows(request.params)
```

### Acceptance Criteria

- [ ] `get_escrow_balance` returns correct escrow data
- [ ] `get_claimable_escrows` finds all escrows user can claim
- [ ] `get_sent_escrows` shows all escrows user has sent to
- [ ] Proper error handling for invalid inputs
- [ ] SDK can successfully call all three endpoints

### Testing

```bash
# Test via curl (assuming node is running)

# 1. Check escrow balance
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_escrow_balance",
    "params": {
      "platform": "twitter",
      "username": "@bob"
    }
  }'

# 2. Get claimable escrows
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_claimable_escrows",
    "params": {
      "address": "0x123..."
    }
  }'

# 3. Get sent escrows
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_sent_escrows",
    "params": {
      "sender": "0x123..."
    }
  }'
```

---

## Phase 5: Integration Testing

**Time**: 2-3 hours
**Priority**: High
**Status**: NOT STARTED

### Goals

- Test complete flow end-to-end with SDK + Node
- Verify shard rotation doesn't affect escrows
- Validate security (unauthorized claims rejected)
- Document test results

### Test Scenarios

#### Test 1: Basic Flow

```typescript
/**
 * End-to-end test: Alice sends to @bob, Bob claims
 */
async function testBasicFlow() {
  // Setup
  const alice = createWallet()
  const bob = createWallet()
  await fundWallet(alice.address, 1000n)

  // Step 1: Alice sends 100 DEM to @bob on Twitter
  const depositTx = await escrow.EscrowTransaction.sendToIdentity(
    demos,
    "twitter",
    "@bob",
    100
  )
  await demos.submitTransaction(depositTx)

  // Verify escrow created
  const escrowBalance = await escrow.EscrowQueries.getEscrowBalance(
    demos,
    "twitter",
    "@bob"
  )
  assert(escrowBalance.balance === "100", "Escrow should have 100 DEM")

  // Step 2: Bob links Twitter account
  await demos.Web2.linkTwitter("@bob")

  // Step 3: Bob claims escrow
  const claimTx = await escrow.EscrowTransaction.claimEscrow(
    demos,
    "twitter",
    "@bob"
  )
  await demos.submitTransaction(claimTx)

  // Verify Bob received funds
  const bobBalance = await demos.getBalance(bob.address)
  assert(bobBalance >= 100, "Bob should have at least 100 DEM")

  // Verify escrow deleted
  const escrowAfterClaim = await escrow.EscrowQueries.getEscrowBalance(
    demos,
    "twitter",
    "@bob"
  )
  assert(escrowAfterClaim.exists === false, "Escrow should be deleted")
}
```

#### Test 2: Shard Rotation

```typescript
/**
 * Test that shard rotation doesn't affect escrow state
 */
async function testShardRotation() {
  const alice = createWallet()
  const bob = createWallet()
  await fundWallet(alice.address, 1000n)

  // Create escrow at block N
  const currentBlock = await getLastBlockNumber()
  const depositTx = await escrow.EscrowTransaction.sendToIdentity(
    demos,
    "twitter",
    "@bob",
    100
  )
  await demos.submitTransaction(depositTx)

  // Wait for shard rotation (multiple blocks)
  await waitForBlocks(5)

  // Verify escrow still exists
  const escrowAfterRotation = await escrow.EscrowQueries.getEscrowBalance(
    demos,
    "twitter",
    "@bob"
  )

  assert(escrowAfterRotation.exists === true, "Escrow should still exist")
  assert(escrowAfterRotation.balance === "100", "Balance unchanged")

  // Bob can still claim after rotation
  await demos.Web2.linkTwitter("@bob")
  const claimTx = await escrow.EscrowTransaction.claimEscrow(
    demos,
    "twitter",
    "@bob"
  )
  await demos.submitTransaction(claimTx)

  const bobBalance = await demos.getBalance(bob.address)
  assert(bobBalance >= 100, "Claim successful after rotation")
}
```

#### Test 3: Security (Unauthorized Claim)

```typescript
/**
 * Test that users cannot claim escrows they don't own
 */
async function testSecurity() {
  const alice = createWallet()
  const eve = createWallet() // Attacker
  await fundWallet(alice.address, 1000n)

  // Alice sends to @bob
  const depositTx = await escrow.EscrowTransaction.sendToIdentity(
    demos,
    "twitter",
    "@bob",
    100
  )
  await demos.submitTransaction(depositTx)

  // Eve tries to claim without proving @bob
  try {
    const evilClaimTx = await escrow.EscrowTransaction.claimEscrow(
      demos,
      "twitter",
      "@bob"
    )
    await demos.submitTransaction(evilClaimTx)

    throw new Error("SECURITY BREACH: Eve claimed without proof!")
  } catch (error) {
    assert(
      error.message.includes("not proven ownership"),
      "Claim correctly rejected"
    )
  }

  // Verify escrow untouched
  const escrowBalance = await escrow.EscrowQueries.getEscrowBalance(
    demos,
    "twitter",
    "@bob"
  )
  assert(escrowBalance.balance === "100", "Escrow intact")
}
```

#### Test 4: Expiry & Refund

```typescript
/**
 * Test escrow expiry and refund
 */
async function testExpiry() {
  const alice = createWallet()
  await fundWallet(alice.address, 1000n)

  // Create escrow with short expiry
  const depositTx = await escrow.EscrowTransaction.sendToIdentity(
    demos,
    "twitter",
    "@unclaimed_user",
    100,
    { expiryDays: 0.00001 } // ~1 second
  )
  await demos.submitTransaction(depositTx)

  // Wait for expiry
  await sleep(2000)

  // Alice refunds
  const refundTx = await escrow.EscrowTransaction.refundExpiredEscrow(
    demos,
    "twitter",
    "@unclaimed_user"
  )
  await demos.submitTransaction(refundTx)

  // Verify Alice got funds back
  const aliceBalance = await demos.getBalance(alice.address)
  assert(aliceBalance >= 1000n, "Refund successful")
}
```

### Acceptance Criteria

- [ ] All 4 test scenarios pass
- [ ] Escrows survive shard rotation
- [ ] Security test confirms unauthorized claims rejected
- [ ] Expiry mechanism works correctly
- [ ] Test results documented

---

## Performance Considerations (Phase 4)

### ⚠️ CRITICAL: Performance Warnings

#### `get_sent_escrows` - Full Table Scan

**Current implementation** does a full table scan - acceptable for testnet/MVP but **WILL CAUSE TIMEOUTS** in production with 10k+ accounts.

**Production optimization options**:

1. **Add index on escrow deposits**:
   - Create JSONB GIN index on `escrows` column
   - Filter by `deposits[*].from` field

2. **Add tracking table**:
   ```sql
   CREATE TABLE escrow_deposits_index (
     sender_address TEXT,
     escrow_address TEXT,
     amount BIGINT,
     timestamp BIGINT,
     PRIMARY KEY (sender_address, escrow_address)
   );
   ```

3. **Cache recently queried results** (Redis/in-memory)

For Phase 4 MVP, the full table scan is acceptable given expected testnet usage.

---

## Next Steps

1. ✅ Review and understand Phase 4 requirements
2. ⏳ Implement RPC endpoints (endpointHandlers.ts + server_rpc.ts)
3. ⏳ Test endpoints with curl/Postman
4. ⏳ Test with SDK query helpers
5. ⏳ Run integration test scenarios (Phase 5)
6. ⏳ Deploy to testnet

---

See [STATUS.md](./STATUS.md) for current implementation progress.
