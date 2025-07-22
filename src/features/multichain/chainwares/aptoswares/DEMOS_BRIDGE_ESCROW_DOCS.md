# Demos Bridge Escrow Smart Contract Documentation

## Overview

The Demos Bridge Escrow smart contract provides USDC liquidity management for Demos Network's cross-chain bridge operations. When users bridge assets (e.g., ETH from Solana to Arbitrum), this contract locks the equivalent USDC amount as collateral/liquidity during the bridge operation, releasing it once the bridge is confirmed, failed, or expired.

**Available Versions:**
- **Basic Version**: `my_addrx::DemosBridgeEscrow` - Core functionality only
- **Enhanced Version**: `my_addrx::DemosBridgeEscrowEnhanced` - **RECOMMENDED** - Includes emergency functions, operational limits, fees, and advanced security

> **⚠️ PRODUCTION RECOMMENDATION**: Use the Enhanced version (`DemosBridgeEscrowEnhanced`) for production deployments as it includes critical security features and operational safeguards missing from the basic version.

## Contract Address

Module: `my_addrx::DemosBridgeEscrowEnhanced` (Enhanced - Recommended)
Module: `my_addrx::DemosBridgeEscrow` (Basic - Development Only)

## Architecture

### Bridge Operation Lifecycle

1. **Initiation**: Demos calculates required USDC for a bridge operation and calls `initiate_bridge()`
2. **Processing**: USDC is locked while the cross-chain bridge occurs on other networks
3. **Resolution**: Bridge is either:
   - **Confirmed**: `confirm_bridge()` releases locked USDC back to pool
   - **Failed**: `fail_bridge()` releases locked USDC back to pool
   - **Expired**: `expire_bridge()` releases locked USDC after timeout

## Core Data Structures

### BridgeEscrow / BridgeEscrowEnhanced
Main contract state:

**Basic Version (BridgeEscrow):**
- `usdc_store: Coin<USDC>` - USDC liquidity pool
- `bridge_operations: Table<vector<u8>, BridgeOperation>` - Active bridge operations
- `total_locked: u64` - Total USDC currently locked in active bridges
- `authorized_addresses: vector<address>` - Demos multisig addresses
- `owner: address` - Contract administrator
- Event handles for all operations

**Enhanced Version (BridgeEscrowEnhanced) - Additional Features:**
- `is_paused: bool` - Emergency pause state
- `limits: OperationalLimits` - Min/max amounts and rate limits
- `rate_tracker: RateLimitTracker` - Volume tracking for rate limiting
- `fee_rate_bp: u64` - Fee rate in basis points
- `collected_fees: u64` - Accumulated fees
- Additional event handles for emergency operations and fees

### BridgeOperation
Individual bridge operation data:
- `bridge_id: vector<u8>` - Unique identifier for the bridge
- `user_address: address` - User who initiated the bridge
- `source_chain/dest_chain: String` - Origin and destination chains
- `source_asset/dest_asset: String` - Assets being bridged
- `locked_usdc_amount: u64` - USDC locked for this operation
- `created_timestamp: u64` - When bridge was initiated
- `timeout_timestamp: u64` - When bridge expires if not completed
- `status: u8` - Current status (pending/confirmed/failed/expired)

## Bridge Status Constants

- `BRIDGE_STATUS_PENDING = 1` - Bridge operation in progress
- `BRIDGE_STATUS_CONFIRMED = 2` - Bridge completed successfully
- `BRIDGE_STATUS_FAILED = 3` - Bridge failed
- `BRIDGE_STATUS_EXPIRED = 4` - Bridge timed out

## Functions

### Administrative Functions

#### Basic Version: `initialize(owner: &signer, authorized_addresses: vector<address>)`
**Purpose:** Initialize the basic bridge escrow contract
**Access:** Public entry, callable once
**Parameters:**
- `owner` - Contract owner/administrator
- `authorized_addresses` - Vector of Demos multisig addresses
**Errors:**
- `E_ALREADY_INITIALIZED` - Contract already initialized

#### Enhanced Version: `initialize(owner, authorized_addresses, min_bridge_amount, max_bridge_amount, max_hourly_volume, max_daily_volume, fee_rate_bp)`
**Purpose:** Initialize the enhanced bridge escrow contract with operational limits and fees
**Access:** Public entry, callable once
**Parameters:**
- `owner` - Contract owner/administrator
- `authorized_addresses` - Vector of Demos multisig addresses
- `min_bridge_amount` - Minimum USDC per bridge operation
- `max_bridge_amount` - Maximum USDC per bridge operation
- `max_hourly_volume` - Maximum USDC volume per hour
- `max_daily_volume` - Maximum USDC volume per day
- `fee_rate_bp` - Fee rate in basis points (e.g., 10 = 0.1%)
**Errors:**
- `E_ALREADY_INITIALIZED` - Contract already initialized

#### `add_liquidity(account: &signer, amount: u64)`
**Purpose:** Add USDC liquidity to the escrow pool
**Access:** Owner or authorized addresses only
**Parameters:**
- `account` - Liquidity provider (must be authorized)
- `amount` - Amount of USDC to add
**Events:** Emits `LiquidityAddedEvent`
**Errors:**
- `E_NOT_AUTHORIZED` - Caller not authorized
- `E_ZERO_AMOUNT` - Amount cannot be zero

#### `remove_liquidity(owner: &signer, amount: u64)`
**Purpose:** Remove USDC liquidity from the escrow pool
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
- `amount` - Amount of USDC to remove (must not exceed unlocked liquidity)
**Events:** Emits `LiquidityRemovedEvent`
**Errors:**
- `E_NOT_AUTHORIZED` - Caller is not owner
- `E_INSUFFICIENT_LIQUIDITY` - Not enough unlocked liquidity

### Emergency Functions (Enhanced Version Only)

#### `emergency_pause(owner: &signer)`
**Purpose:** Emergency pause all bridge operations
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
**Events:** Emits `EmergencyEvent` with action "PAUSE"
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner

#### `emergency_unpause(owner: &signer)`
**Purpose:** Resume bridge operations after emergency pause
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
**Events:** Emits `EmergencyEvent` with action "UNPAUSE"
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner

#### `emergency_withdraw(owner: &signer, amount: u64)`
**Purpose:** Emergency withdrawal of funds (extreme situations only)
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
- `amount` - Amount to withdraw
**Events:** Emits `EmergencyEvent` with action "EMERGENCY_WITHDRAW"
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner
- `E_INSUFFICIENT_LIQUIDITY` - Not enough funds

#### `add_authorized_address(owner: &signer, new_address: address)`
**Purpose:** Add new authorized address for Demos operations
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
- `new_address` - Address to authorize
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner

#### `remove_authorized_address(owner: &signer, address_to_remove: address)`
**Purpose:** Remove authorized address
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
- `address_to_remove` - Address to remove from authorized list
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner

#### `withdraw_fees(owner: &signer, amount: u64)`
**Purpose:** Withdraw collected bridge fees
**Access:** Owner only
**Parameters:**
- `owner` - Contract owner
- `amount` - Amount of fees to withdraw
**Errors:**
- `E_NOT_OWNER` - Caller is not contract owner
- `E_INSUFFICIENT_LIQUIDITY` - Not enough collected fees

### Bridge Operation Functions

#### `initiate_bridge(...)`
**Purpose:** Lock USDC for a new bridge operation
**Access:** Authorized addresses only (Demos multisig)
**Parameters:**
- `caller` - Authorized Demos address
- `bridge_id` - Unique bridge identifier
- `user_address` - User initiating the bridge
- `source_chain/dest_chain` - Chain information
- `source_asset/dest_asset` - Asset information
- `lock_amount` - USDC amount to lock
- `timeout_seconds` - Bridge timeout duration
**Events:** Emits `BridgeInitiatedEvent`
**Errors:**
- `E_NOT_AUTHORIZED` - Caller not authorized
- `E_BRIDGE_ALREADY_EXISTS` - Bridge ID already in use
- `E_INSUFFICIENT_LIQUIDITY` - Not enough available USDC
- `E_ZERO_AMOUNT` - Lock amount cannot be zero

#### `confirm_bridge(caller: &signer, bridge_id: vector<u8>)`
**Purpose:** Confirm successful bridge completion and release locked USDC
**Access:** Authorized addresses only
**Parameters:**
- `caller` - Authorized Demos address
- `bridge_id` - Bridge to confirm
**Events:** Emits `BridgeConfirmedEvent`
**Errors:**
- `E_NOT_AUTHORIZED` - Caller not authorized
- `E_BRIDGE_NOT_FOUND` - Bridge ID not found
- `E_BRIDGE_ALREADY_COMPLETED` - Bridge already processed

#### `fail_bridge(caller: &signer, bridge_id: vector<u8>)`
**Purpose:** Mark bridge as failed and release locked USDC
**Access:** Authorized addresses only
**Parameters:**
- `caller` - Authorized Demos address
- `bridge_id` - Bridge to mark as failed
**Events:** Emits `BridgeFailedEvent`
**Errors:**
- `E_NOT_AUTHORIZED` - Caller not authorized
- `E_BRIDGE_NOT_FOUND` - Bridge ID not found
- `E_BRIDGE_ALREADY_COMPLETED` - Bridge already processed

#### `expire_bridge(caller: &signer, bridge_id: vector<u8>)`
**Purpose:** Expire timed-out bridge and release locked USDC
**Access:** Public (callable by anyone after timeout)
**Parameters:**
- `caller` - Any address
- `bridge_id` - Bridge to expire
**Events:** Emits `BridgeExpiredEvent`
**Errors:**
- `E_BRIDGE_NOT_FOUND` - Bridge ID not found
- `E_BRIDGE_ALREADY_COMPLETED` - Bridge already processed
- `E_BRIDGE_NOT_EXPIRED` - Bridge hasn't reached timeout yet

### View Functions

#### `get_bridge_operation(bridge_id: vector<u8>): Option<BridgeOperation>`
**Purpose:** Get detailed information about a bridge operation
**Access:** Public view
**Returns:** Bridge operation details or none if not found

#### Basic Version: `get_liquidity_stats(): (u64, u64, u64)`
**Purpose:** Get current liquidity statistics
**Access:** Public view
**Returns:** Tuple of (total_liquidity, locked_liquidity, available_liquidity)

#### Enhanced Version: `get_enhanced_stats(): (u64, u64, u64, u64, bool)`
**Purpose:** Get comprehensive liquidity and operational statistics
**Access:** Public view
**Returns:** Tuple of (total_liquidity, locked_liquidity, available_liquidity, collected_fees, is_paused)

#### Enhanced Version: `get_operational_limits(): (u64, u64, u64, u64)`
**Purpose:** Get current operational limits
**Access:** Public view
**Returns:** Tuple of (min_bridge_amount, max_bridge_amount, max_hourly_volume, max_daily_volume)

#### Enhanced Version: `get_rate_limit_status(): (u64, u64, u64, u64)`
**Purpose:** Get current rate limit usage and timing
**Access:** Public view
**Returns:** Tuple of (hourly_volume_used, daily_volume_used, seconds_since_hour_reset, seconds_since_day_reset)

## Events

### BridgeInitiatedEvent
```move
struct BridgeInitiatedEvent {
    bridge_id: vector<u8>,
    user_address: address,
    source_chain: String,
    dest_chain: String,
    locked_amount: u64,
    timeout_timestamp: u64,
    timestamp: u64,
}
```

### BridgeConfirmedEvent
```move
struct BridgeConfirmedEvent {
    bridge_id: vector<u8>,
    user_address: address,
    locked_amount: u64,
    timestamp: u64,
}
```

### BridgeFailedEvent
```move
struct BridgeFailedEvent {
    bridge_id: vector<u8>,
    user_address: address,
    locked_amount: u64,
    timestamp: u64,
}
```

### BridgeExpiredEvent
```move
struct BridgeExpiredEvent {
    bridge_id: vector<u8>,
    user_address: address,
    locked_amount: u64,
    timestamp: u64,
}

### Additional Events (Enhanced Version Only)

#### EmergencyEvent
```move
struct EmergencyEvent {
    action: String,          // Action taken ("PAUSE", "UNPAUSE", "EMERGENCY_WITHDRAW")
    executor: address,       // Who executed the emergency action
    amount: Option<u64>,     // Amount if applicable (emergency withdraw)
    timestamp: u64,          // Action timestamp
}
```

#### FeeCollectedEvent
```move
struct FeeCollectedEvent {
    bridge_id: vector<u8>,   // Bridge ID that generated fee
    fee_amount: u64,         // Fee amount collected
    timestamp: u64,          // Collection timestamp
}
```

## Error Codes

| Code | Constant | Description |
|------|----------|-------------|
| 1 | `E_NOT_INITIALIZED` | Escrow contract not initialized |
| 2 | `E_ALREADY_INITIALIZED` | Escrow already initialized |
| 3 | `E_INSUFFICIENT_LIQUIDITY` | Not enough available USDC |
| 4 | `E_BRIDGE_NOT_FOUND` | Bridge operation not found |
| 5 | `E_BRIDGE_ALREADY_EXISTS` | Bridge ID already in use |
| 6 | `E_NOT_AUTHORIZED` | Caller not authorized |
| 7 | `E_BRIDGE_EXPIRED` | Bridge has expired |
| 8 | `E_BRIDGE_ALREADY_COMPLETED` | Bridge already processed |
| 9 | `E_INVALID_TIMEOUT` | Invalid timeout value |
| 10 | `E_ZERO_AMOUNT` | Amount cannot be zero |
| 11 | `E_BRIDGE_NOT_EXPIRED` | Bridge not yet expired |

### Additional Error Codes (Enhanced Version Only)

| Code | Constant | Description |
|------|----------|-------------|
| 12 | `E_CONTRACT_PAUSED` | Operations blocked due to emergency pause |
| 13 | `E_AMOUNT_TOO_SMALL` | Bridge amount below minimum limit |
| 14 | `E_AMOUNT_TOO_LARGE` | Bridge amount above maximum limit |
| 15 | `E_RATE_LIMIT_EXCEEDED` | Hourly or daily volume limit exceeded |
| 16 | `E_NOT_OWNER` | Operation requires contract owner |

## Integration Example

### Typical Bridge Flow

```move
// 1. User wants to bridge 1 ETH from Solana to Arbitrum
// 2. Demos calculates 2000 USDC equivalent needed for liquidity
// 3. Demos calls initiate_bridge:

public entry fun demos_initiate_user_bridge(demos_signer: &signer) {
    DemosBridgeEscrow::initiate_bridge(
        demos_signer,
        b"bridge_eth_sol_arb_001",    // Unique bridge ID
        @0x456,                       // User address
        b"Solana",                    // Source chain
        b"Arbitrum",                  // Destination chain
        b"ETH",                       // Source asset
        b"ETH",                       // Destination asset
        2000,                         // Lock 2000 USDC
        3600                          // 1 hour timeout
    );
}

// 4. After successful bridge completion on other chains:
public entry fun demos_confirm_bridge(demos_signer: &signer) {
    DemosBridgeEscrow::confirm_bridge(
        demos_signer,
        b"bridge_eth_sol_arb_001"
    );
    // 2000 USDC released back to available pool
}
```

## Security Features

1. **Multi-signature Access Control**: Only authorized Demos addresses can initiate/confirm/fail bridges
2. **Bridge ID Uniqueness**: Prevents duplicate bridge operations
3. **Timeout Protection**: Automatic expiration prevents funds from being locked forever
4. **Liquidity Validation**: Ensures sufficient unlocked USDC before initiating bridges
5. **Status Protection**: Prevents double-processing of bridge operations
6. **Event Logging**: Complete audit trail of all operations

## Deployment & Setup

1. **Deploy Contract**: Deploy with initial owner address
2. **Initialize**: Call `initialize()` with Demos multisig addresses
3. **Add Initial Liquidity**: Owner adds USDC to the escrow pool
4. **Authorize Demos**: Ensure Demos multisig addresses are in authorized list
5. **Integration**: Demos integrates contract calls into bridge workflow

## Monitoring & Analytics

The contract emits comprehensive events for:
- Bridge operation lifecycle tracking
- Liquidity pool management
- Performance analytics
- Failure analysis and timeout monitoring

## Gas Optimization

- Bridge operations use efficient table storage
- Status checks minimize computation
- Event emission provides off-chain monitoring capabilities
- Timeout mechanism allows community-driven cleanup

## Future Enhancements

- Dynamic fee calculation based on locked duration
- Multiple asset support beyond USDC
- Advanced timeout strategies (progressive timeouts)
- Bridge operation batching for gas efficiency
- Automated market making integration
- Cross-chain proof verification

## Version History

- v1.0.0 - Initial bridge escrow implementation for Demos Network integration