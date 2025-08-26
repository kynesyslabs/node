# LiquidityTank Smart Contract - Technical Reference

## Contract Overview

Secure multisig liquidity management contract with gasless transaction support for the Demos Network bridge system.

**Address**: Deploy with constructor parameters
**Network**: Multi-chain compatible
**Solidity**: ^0.8.30

## Function Reference

### Initialization Functions

#### `setAuthorizedAddresses(address[] _addresses)`
- **Purpose**: One-time setup of multisig owners
- **Access**: Deployer only
- **Requirements**: 3-50 addresses, no duplicates
- **Gas**: ~200k + (50k per address)

### Core Multisig Functions

#### `multisigTransfer(uint256 nonce, address token, address to, uint256 amount, uint256 slippageBps)`
- **Purpose**: Execute ETH/ERC20 transfers with 2/3 approval
- **Access**: Authorized addresses only
- **Parameters**:
  - `nonce`: Unique proposal identifier
  - `token`: `address(0)` for ETH, contract address for ERC20
  - `to`: Recipient address
  - `amount`: Amount in wei/token units
  - `slippageBps`: Slippage tolerance (0-1000 = 0-10%)
- **Gas**: First approval ~254k, second ~221k

#### `proposeNextOwners(uint256 nonce, address[] newOwners)`
- **Purpose**: Rotate multisig ownership
- **Access**: Authorized addresses only
- **Requirements**: 3-50 new owners, 2/3 approval
- **Gas**: ~300k + (30k per owner)

### Gasless System Functions

#### `depositGasSubsidy()`
- **Purpose**: Fund contract's gas subsidy pool
- **Access**: Anyone (payable)
- **Usage**: Send ETH to sponsor user transactions

#### `configureGasSubsidy(bool enabled, uint256 maxSubsidy, uint256 dailyLimit)`
- **Purpose**: Configure gasless transaction limits
- **Access**: Deployer only
- **Parameters**:
  - `enabled`: Enable/disable gas subsidies
  - `maxSubsidy`: Max gas cost per transaction (wei)
  - `dailyLimit`: Max total gas subsidies per day (wei)

#### `reimburseGas(address user)`
- **Purpose**: Reimburse gas costs from subsidy pool
- **Access**: Anyone (payable)
- **Usage**: Send gas cost amount, get reimbursed automatically

#### `executeMetaTransaction(address user, bytes signature, uint256 nonce, address token, address to, uint256 amount, uint256 slippageBps)`
- **Purpose**: Execute transaction on behalf of user (gasless)
- **Access**: Anyone
- **Requirements**: Valid user signature, sufficient subsidy pool
- **Gas**: Contract pays automatically

### View Functions

#### `isTrustedForwarder(address forwarder)`
- **Returns**: `bool` - Whether address is trusted forwarder
- **Usage**: EIP-2771 meta-transaction compatibility

#### `gasSubsidyPool()`
- **Returns**: `uint256` - Current gas subsidy pool balance (wei)

#### `gasSubsidyEnabled()`
- **Returns**: `bool` - Whether gas subsidies are active

#### `maxGasSubsidy()`
- **Returns**: `uint256` - Maximum gas cost per transaction (wei)

#### `isAuthorized(address account)`
- **Returns**: `bool` - Whether address can approve proposals

#### `authorizedCount()`
- **Returns**: `uint8` - Number of authorized addresses

### Emergency Functions

#### `pause()` / `unpause()`
- **Purpose**: Emergency stop/resume contract
- **Access**: Deployer only
- **Effect**: Prevents all operations except emergency functions

## State Variables

### Core Storage
```solidity
mapping(address => bool) public isAuthorized;      // Authorized multisig owners
address[] public authorizedAddresses;              // Array of owners
uint8 public authorizedCount;                      // Owner count
address public immutable deployer;                 // Contract deployer
bool public initialized;                           // Setup completed flag
```

### Proposal System
```solidity
mapping(bytes32 => MultisigProposal) public proposals;  // Active proposals
uint256 public proposalNonce;                           // Internal nonce counter
```

### Gasless System
```solidity
uint256 public gasSubsidyPool;                     // ETH pool for gas subsidies
bool public gasSubsidyEnabled;                     // Gasless system toggle
uint256 public maxGasSubsidy;                      // Max gas per transaction
uint256 public dailySubsidyLimit;                  // Max gas per day
mapping(address => mapping(uint256 => uint256)) dailyUserUsage;  // User daily limits
mapping(uint256 => uint256) dailyTotalUsage;      // Global daily usage
```

## Events

### Transfer Events
```solidity
event TransferExecuted(address indexed token, address indexed recipient, uint256 expectedAmount, uint256 actualAmount);
event ProposalApproved(bytes32 indexed proposalId, address indexed approver, uint8 approvalCount);
```

### Ownership Events
```solidity
event OwnershipRotated(address[] oldOwners, address[] newOwners);
event AuthorizationGranted(address indexed account, address indexed grantor);
event AuthorizationRevoked(address indexed account, address indexed revoker);
```

### Gasless Events
```solidity
event GasSubsidyDeposited(uint256 amount, uint256 newTotal);
event GasSubsidyConfigured(bool enabled, uint256 maxSubsidy);
event GasSubsidyUsed(address indexed user, uint256 gasCost, uint256 totalUsed);
```

## Error Codes

### Access Control
- `NotAuthorized()`: Caller not in authorized addresses
- `NotDeployer()`: Only deployer can call function
- `AlreadyInitialized()`: Contract already set up

### Proposal Validation
- `ProposalDataMismatch()`: Inconsistent parameters across approvals
- `AlreadyApproved()`: User already approved this proposal
- `AlreadyExecuted()`: Proposal already executed
- `ProposalExpired()`: Proposal past deadline

### Transfer Validation
- `InvalidAddress()`: Zero address or invalid recipient
- `InvalidAmount()`: Zero or invalid transfer amount
- `InsufficientBalance()`: Contract lacks sufficient funds
- `SlippageExceeded()`: Fee-on-transfer loss exceeds tolerance
- `InvalidSlippageBps()`: Slippage tolerance > 10%

### System State
- `ContractPausedError()`: Operations disabled during pause
- `ReentrancyGuard()`: Prevented reentrancy attack

## Security Features

### Front-running Protection
- Internal `_generateProposalId()` with cryptographic entropy
- Multiple unpredictable sources (blockhash, timestamp, gas, nonce)
- Hash chain approach prevents proposal ID prediction

### Slippage Protection
- Dual-balance validation (contract loss + recipient gain)
- Support for fee-on-transfer tokens
- Configurable tolerance per transaction

### Access Control
- Role-based permissions with multisig governance
- Emergency pause capability
- Ownership rotation with proposal system

### Gasless Security
- Signature verification with replay protection
- Daily usage limits per user and globally
- Domain separation prevents cross-contract attacks

This contract provides enterprise-grade security for DeFi liquidity management with revolutionary gasless user experience.