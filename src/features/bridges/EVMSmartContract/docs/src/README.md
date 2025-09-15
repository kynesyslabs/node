# LiquidityTank Smart Contract

A secure liquidity tank with rotating co-ownership managed by multisig operations for the Demos Network Native Bridges.

## Overview

The LiquidityTank contract is a core component of the Demos Native Bridge architecture. It serves as a multisig-controlled treasury that holds liquidity across different EVM chains. The contract features rotating ownership, gasless operations, and comprehensive security mechanisms.

## Core Architecture

### Multisig Operations
- **2/3 Majority Voting**: All operations require approval from 2/3 of authorized addresses
- **Proposal System**: Time-bound proposals with unique IDs prevent front-running
- **Rotating Co-ownership**: Current owners cannot set themselves as new owners (enforces true rotation)

### Key Features
- **Gasless Transactions**: Users can interact without holding native tokens for gas
- **Gas Sponsorship**: Contract automatically reimburses transaction costs from a subsidy pool
- **Emergency Recovery**: 15-day timeout system for deployer intervention if multisig becomes inactive
- **Slippage Protection**: Comprehensive protection against fee-on-transfer tokens
- **Token Support**: Native ETH and any ERC20 token transfers

## How It Works

### 1. Initialization
```solidity
// Deploy contract (deployer becomes emergency recovery authority)
constructor()

// One-time setup of authorized addresses (minimum 3 required)
setAuthorizedAddresses(address[] memory _addresses)
```

### 2. Standard Operations

#### Transfer Funds (Multisig Required)
```solidity
multisigTransfer(
    uint256 nonce,           // Unique proposal identifier
    address token,           // Token contract (address(0) for ETH)
    address to,              // Recipient address
    uint256 amount,          // Amount to transfer
    uint256 slippageBps      // Maximum slippage (basis points)
)
```

**Flow**:
1. Any authorized address creates a proposal with unique nonce
2. Other authorized addresses call the same function with identical parameters
3. When 2/3 threshold is reached, transfer executes automatically
4. Gas costs are reimbursed to the final approver

#### Ownership Rotation
```solidity
proposeNextOwners(
    uint256 nonce,                    // Unique proposal identifier
    address[] calldata newOwners      // New authorized addresses
)
```

**Flow**:
1. Current owners propose new ownership structure
2. 2/3 approval required from current owners
3. Atomic replacement of all authorized addresses
4. Enforces true rotation (current owners cannot include themselves)

### 3. Gasless Bridge Operations

#### Deposit to Tank
```solidity
depositUSDCToTank(
    address user,              // User depositing tokens
    bytes calldata signature,  // User's authorization signature
    uint256 nonce,            // Replay protection nonce
    address usdcAddress,      // USDC contract address
    uint256 amount            // Deposit amount
)
```

#### Combined Deposit + Bridge
```solidity
depositAndBridge(
    address user,               // User initiating bridge
    bytes calldata signature,   // User's authorization signature
    uint256 nonce,             // Replay protection nonce
    string calldata tokenName, // Human-readable token name ("usdc", "eth")
    uint256 depositAmount,     // Amount to deposit and bridge
    string calldata destChain, // Destination chain identifier
    address recipient,         // Recipient on destination chain
    uint256 bridgeFeeBps       // Bridge fee in basis points
)
```

#### Permit-Enabled Bridge (Single Transaction)
```solidity
depositAndBridgeWithPermit(
    address user,               // User depositing and bridging
    bytes calldata signature,   // User's authorization signature
    uint256 nonce,             // Replay protection nonce
    address tokenAddress,      // ERC20 token with permit support
    uint256 depositAmount,     // Amount to deposit and bridge
    string calldata destChain, // Destination chain
    address recipient,         // Recipient address
    uint256 bridgeFeeBps,      // Bridge fee in basis points
    uint256 permitDeadline,    // Permit expiration
    uint8 v, bytes32 r, bytes32 s  // Permit signature components
)
```

## Security Features

### Access Control
- **Authorized Addresses**: Only whitelisted addresses can approve operations
- **Deployer Authority**: Emergency recovery and configuration functions
- **Rotation Enforcement**: Current owners cannot set themselves as new owners

### Protection Mechanisms
- **Reentrancy Guard**: Custom gas-efficient implementation
- **Pause/Unpause**: Emergency contract suspension
- **Proposal Expiration**: 1-hour timeout for proposals
- **Signature Verification**: EIP-712 style message signing
- **Nonce Protection**: Prevents replay attacks

### Emergency Recovery
- **15-Day Timeout**: If no ownership rotation occurs, deployer can reset
- **Emergency Withdrawal**: Multisig-controlled emergency fund recovery
- **Contract Pause**: Immediate suspension in crisis situations

## Gas Optimization

### Storage Packing
- **Efficient Struct Layout**: Packed structs to minimize storage slots
- **Optimal Data Types**: uint8, uint40 for appropriate ranges
- **Single-Slot Variables**: Multiple boolean flags in one storage slot

### Execution Optimization
- **Custom Errors**: ~2k gas savings per revert vs string messages
- **Low-Level Calls**: Direct token transfers without interface imports
- **Unchecked Loops**: Gas-efficient iteration patterns
- **Via IR Compilation**: Enabled for deep stack optimizations

### Gas Sponsorship
```solidity
// Configure gas subsidization
configureGasSubsidy(bool enabled, uint256 maxSubsidy, uint256 dailyLimit)

// Deposit ETH for gas sponsorship
depositGasSubsidy() payable

// Automatic reimbursement after operations
_payGasFromPool(address gasPayee)
```

## Token Support

### Native ETH
- Direct transfers via `payable` functions
- Balance checking via `address(this).balance`
- No slippage concerns for native transfers

### ERC20 Tokens
- **Standard Transfers**: Using OpenZeppelin SafeERC20
- **Fee-on-Transfer Protection**: Pre/post balance checking
- **Permit Support**: EIP-2612 gasless approvals
- **Contract Validation**: Ensures valid ERC20 interfaces

### Token Name Mapping
```solidity
// Human-readable token names
setTokenNameMapping("usdc", 0x...USDCAddress)
setTokenNameMapping("eth", address(0))

// Usage in bridge operations
depositAndBridge(..., "usdc", ...) // Resolves to USDC contract
```

## Events

### Proposal Lifecycle
- `ProposalCreated`: New multisig proposal initiated
- `ProposalApproved`: Address approves proposal
- `ProposalExecuted`: Proposal reaches threshold and executes
- `ProposalCancelled`: Proposer cancels pending proposal

### Operations
- `TransferExecuted`: Funds transferred with actual amounts
- `OwnersRotated`: Ownership structure updated
- `TokenDeposited`: User deposits tracked
- `BridgeOperationInitiated`: Cross-chain bridge started

### Administrative
- `AuthorizationGranted`/`Revoked`: Access control changes
- `ContractPaused`/`Unpaused`: Emergency state changes
- `GasSubsidyConfigured`: Gas sponsorship settings updated

## Integration with Demos Network

### Role in Native Bridges
1. **Liquidity Holding**: Stores bridged assets across EVM chains
2. **Shard Control**: Owned and operated by current validation shard
3. **Atomic Rotation**: Updates ownership when shard membership changes
4. **Cross-Chain Coordination**: Enables seamless asset movement

### Consensus Integration
- Validation shard members control multisig keys
- Bridge operations authorized through Demos consensus
- Automatic ownership updates during shard rotation
- Emergency recovery via original deployer authority

## Deployment Information

### Contract Details
- **Solidity Version**: 0.8.27
- **License**: MIT
- **Optimization**: Enabled with 200 runs + via-ir
- **Dependencies**: OpenZeppelin ERC20 utilities

### Network Deployments
- **Ethereum Sepolia**: `0x11c1197798d3b1caB6970577361172C00e4C5F36`
- **Other Testnets**: Deployment addresses configured in `config/tankAddresses.json`

### Configuration Files
- **Tank Addresses**: `config/tankAddresses.json`
- **Contract ABI**: `config/abis/LiquidityTank.json`
- **Foundry Config**: `foundry.toml`

## Error Handling

The contract uses custom errors for gas efficiency:

- `NotAuthorized()`: Unauthorized access attempt
- `ProposalExpired()`: Proposal deadline exceeded
- `InsufficientBalance()`: Insufficient tank balance
- `SlippageExceeded()`: Transfer amount below slippage threshold
- `InvalidSignature()`: Signature verification failed
- `ReentrancyGuard()`: Reentrancy attempt detected

## Security Considerations

### Audited Areas
- **Reentrancy Protection**: Custom guard implementation
- **Access Control**: Role-based permission system
- **Ownership Vulnerabilities**: Rotation enforcement mechanisms
- **Signature Verification**: EIP-712 compliance
- **Integer Overflow**: Solidity 0.8+ built-in protection

### Best Practices
- **Minimal External Dependencies**: Reduced attack surface
- **Fail-Safe Defaults**: Conservative error handling
- **Event Transparency**: Comprehensive operation logging
- **Emergency Controls**: Pause/recovery mechanisms
- **Gas DoS Protection**: Efficient loops and operations

## Version History

- **v1.0.0**: Initial production release with multisig operations
- **v1.1.0**: Added gasless bridge operations
- **v1.2.0**: Implemented EIP-2612 permit support
- **v1.3.0**: Enhanced gas optimization and slippage protection