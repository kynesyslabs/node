# Aptos Core Concepts Guide for Beginners

## Overview

Aptos is a Layer 1 blockchain focused on safety, scalability, and user experience. This guide covers the essential concepts you need to understand to work with Aptos and deploy smart contracts like our Demos Bridge Escrow.

## Key Concepts

### 1. Move Programming Language

**What is Move?**
- Move is Aptos's smart contract programming language
- Designed for safe resource management and formal verification
- Similar to Rust in syntax but with unique resource-oriented features

**Key Move Concepts:**
```move
// Resources - can only be created, moved, or destroyed (never copied)
struct Coin<phantom CoinType> has store {
    value: u64,  // Amount of coins
}

// Structs with different abilities
struct Data has store, copy, drop {  // Can be stored, copied, dropped
    value: u64,
}

struct Account has key {  // Can be stored in global storage
    balance: u64,
}
```

### 2. Account Model

**Aptos Account Structure:**
- Each account has a unique 32-byte address (e.g., `0x1234...abcd`)
- Accounts can hold:
  - **APT tokens** (native gas token)
  - **Other tokens** (like USDC)
  - **Resources** (smart contract data)
  - **Modules** (smart contract code)

**Account Types:**
```bash
# Standard Account
0x1a2b3c4d...  # User-controlled account

# Resource Account  
0x5e6f7890...  # Contract-controlled account

# System Accounts
0x1  # Framework account (core modules)
0x2  # Standard library
```

### 3. Resources vs Global Storage

**Resources (struct with `key` ability):**
```move
struct MyResource has key {
    value: u64,
}

// Store under account
move_to<MyResource>(signer, MyResource { value: 100 });

// Read from account
let resource = borrow_global<MyResource>(address);

// Remove from account
let MyResource { value } = move_from<MyResource>(address);
```

**Why Resources Matter:**
- Resources ensure data uniqueness (no double-spending)
- Automatic memory management
- Clear ownership semantics

### 4. Coins and Tokens

**Understanding Coin<T>:**
```move
// USDC is a coin type
struct USDC {}  

// Coin<USDC> represents actual USDC tokens
let usdc_coins: Coin<USDC> = coin::withdraw<USDC>(account, 1000);

// Key operations:
coin::value(&usdc_coins)        // Get amount
coin::merge(&mut coin1, coin2)  // Combine coins
coin::extract(&mut coins, 500)  // Split coins
coin::deposit(address, coins)   // Send to account
```

**Token Registration:**
```bash
# Users must register to receive tokens
aptos move run \
  --function-id 0x1::managed_coin::register \
  --type-args "0xUSDC_ADDRESS::USDC"
```

### 5. Transactions and Signers

**Signer Pattern:**
```move
public entry fun my_function(account: &signer, amount: u64) {
    let account_addr = signer::address_of(account);
    // Only this account can call this function
}
```

**Transaction Structure:**
1. **Sender** - Who pays gas and signs
2. **Function** - Which smart contract function to call  
3. **Arguments** - Function parameters
4. **Gas** - Computation fee in APT

### 6. Entry Functions vs View Functions

**Entry Functions (can be called externally):**
```move
public entry fun deposit(account: &signer, amount: u64) acquires MyResource {
    // Modify blockchain state
    let coins = coin::withdraw<USDC>(account, amount);
    // ... store coins
}
```

**View Functions (read-only):**
```move
public fun get_balance(address: address): u64 acquires MyResource {
    let resource = borrow_global<MyResource>(address);
    resource.balance  // Returns value, no state changes
}
```

### 7. Events and Logging

**Event Emission:**
```move
struct DepositEvent has drop, store {
    user: address,
    amount: u64,
    timestamp: u64,
}

// In contract
event::emit_event(&mut handle, DepositEvent {
    user: account_addr,
    amount,
    timestamp: timestamp::now_seconds(),
});
```

**Why Events Matter:**
- Off-chain monitoring and analytics
- User interface updates
- Audit trails

### 8. Gas and Fees

**Gas Model:**
- **Gas Units** - Computational cost of operations
- **Gas Price** - APT per gas unit (set by user)
- **Total Fee** = Gas Units × Gas Price

**Gas Optimization:**
```move
// Expensive - multiple storage reads
let val1 = borrow_global<Resource>(addr).field1;
let val2 = borrow_global<Resource>(addr).field2;

// Better - single storage read
let resource = borrow_global<Resource>(addr);
let val1 = resource.field1;
let val2 = resource.field2;
```

### 9. Modules and Deployment

**Module Structure:**
```move
module my_address::MyModule {
    use std::signer;
    use aptos_framework::coin;
    
    // Error constants
    const E_NOT_AUTHORIZED: u64 = 1;
    
    // Structs
    struct MyResource has key {
        value: u64,
    }
    
    // Functions
    public entry fun initialize(account: &signer) {
        // ...
    }
}
```

**Deployment Process:**
1. **Compile**: `aptos move compile`
2. **Deploy**: `aptos move publish`
3. **Call Functions**: `aptos move run --function-id address::module::function`

### 10. Common Patterns

**Capability Pattern (Authorization):**
```move
struct AdminCapability has key, store {}

public entry fun initialize(account: &signer) {
    move_to(account, AdminCapability {});
}

public entry fun admin_function(account: &signer) acquires AdminCapability {
    assert!(exists<AdminCapability>(signer::address_of(account)), E_NOT_ADMIN);
    // Only accounts with AdminCapability can call this
}
```

**Resource Initialization Pattern:**
```move
public entry fun initialize(account: &signer) {
    assert!(!exists<MyResource>(signer::address_of(account)), E_ALREADY_EXISTS);
    move_to(account, MyResource { value: 0 });
}
```

## Aptos vs Other Blockchains

### Aptos vs Ethereum

| Aspect | Ethereum | Aptos |
|--------|----------|-------|
| **Language** | Solidity | Move |
| **VM** | EVM | MoveVM |
| **Account Model** | Externally Owned + Contract | Unified Account |
| **Storage** | Key-Value | Resource-Oriented |
| **Concurrency** | Sequential | Parallel Execution |
| **Gas** | Gas Limit | Gas Units |

### Aptos vs Solana

| Aspect | Solana | Aptos |
|--------|--------|-------|
| **Language** | Rust | Move |
| **Account Model** | Program + Data Accounts | Unified Accounts |
| **Transaction Fee** | SOL | APT |
| **Programming Model** | Programs + PDAs | Modules + Resources |

## Development Workflow

### 1. Local Development
```bash
# Install Aptos CLI
curl -fsSL "https://aptos.dev/scripts/install_cli.py" | python3

# Initialize project
aptos move init --name my_project

# Compile
aptos move compile

# Test
aptos move test
```

### 2. Testnet Deployment
```bash
# Initialize account
aptos init --network testnet

# Fund account
aptos account fund-with-faucet

# Deploy
aptos move publish --named-addresses my_addr=0x123...
```

### 3. Mainnet Deployment
```bash
# Switch to mainnet
aptos init --network mainnet

# Deploy (ensure sufficient APT for gas)
aptos move publish --named-addresses my_addr=0x123...
```

## Essential CLI Commands

### Account Management
```bash
# Create new account
aptos init

# Check account info
aptos account list

# Fund testnet account
aptos account fund-with-faucet

# Check balance
aptos account list --query balance
```

### Contract Operations
```bash
# Compile contract
aptos move compile

# Run tests
aptos move test

# Deploy contract
aptos move publish

# Call function
aptos move run --function-id 0x123::MyModule::my_function --args u64:100

# View function
aptos move view --function-id 0x123::MyModule::get_value
```

### Token Operations
```bash
# Register for token
aptos move run --function-id 0x1::managed_coin::register --type-args "TokenType"

# Transfer tokens
aptos account transfer --account 0x456 --amount 1000

# Check token balance
aptos account list --query resources --account 0x123
```

## Security Best Practices

### 1. Access Control
```move
// Use signer pattern
public entry fun protected_function(account: &signer) {
    let addr = signer::address_of(account);
    assert!(addr == @admin_address, E_NOT_AUTHORIZED);
}
```

### 2. Input Validation
```move
public entry fun deposit(account: &signer, amount: u64) {
    assert!(amount > 0, E_ZERO_AMOUNT);
    assert!(amount <= MAX_AMOUNT, E_AMOUNT_TOO_LARGE);
}
```

### 3. Resource Management
```move
// Always handle coins properly
public entry fun handle_coins(account: &signer, amount: u64) {
    let coins = coin::withdraw<USDC>(account, amount);
    // Either deposit somewhere or store in resource
    coin::deposit(target_address, coins); // Don't let coins disappear!
}
```

### 4. Error Handling
```move
const E_NOT_FOUND: u64 = 1;
const E_ALREADY_EXISTS: u64 = 2;

public entry fun my_function() acquires MyResource {
    assert!(exists<MyResource>(@my_address), error::not_found(E_NOT_FOUND));
}
```

## Common Gotchas for Beginners

1. **Forgetting Resource Abilities**: Resources need `key` to store in global storage
2. **Token Registration**: Users must register before receiving tokens
3. **Signer Requirements**: Only the account owner can provide their signer
4. **Gas Estimation**: Always check gas costs before mainnet deployment
5. **Resource Cleanup**: Properly handle all created coins/resources

## Next Steps

1. **Practice**: Deploy the basic USDC reserve contract on testnet
2. **Read More**: Study the Aptos framework modules
3. **Build**: Create your own simple token or NFT contract
4. **Test**: Write comprehensive tests for your contracts
5. **Deploy**: Move to mainnet when ready

## Useful Resources

- **Aptos Documentation**: https://aptos.dev/
- **Move Book**: https://move-language.github.io/move/
- **Aptos Framework**: https://github.com/aptos-labs/aptos-core/tree/main/aptos-move/framework
- **Aptos Explorer**: https://explorer.aptoslabs.com/
- **Move Prover**: Formal verification tool for Move contracts

## Demos Bridge Escrow Context

In our specific contract:
- **USDC** is the coin type we're managing
- **Bridge operations** are stored as resources with unique IDs
- **Multisig authorization** uses the signer pattern
- **Events** provide monitoring for bridge lifecycle
- **Gas optimization** through efficient storage patterns

This foundation will help you understand how our bridge escrow contract works and how to modify or extend it!