# Hands-On Aptos Guide: Learning by Deploying Demos Bridge Escrow

## Overview

This guide teaches you Aptos by walking through deploying and using our Demos Bridge Escrow contract step-by-step. You'll learn Aptos concepts by actually doing them.

## Prerequisites

- Basic terminal/command line knowledge
- No prior blockchain experience required

## Step 1: Set Up Your Environment

### Install Aptos CLI

```bash
# Install Aptos CLI
curl -fsSL "https://aptos.dev/scripts/install_cli.py" | python3

# Verify installation
aptos --help
```

**What you just did**: Installed the Aptos command-line tool that lets you interact with the Aptos blockchain.

### Create Your First Account

```bash
# Create a new Aptos account
aptos init

# You'll see output like:
# Configuring for profile default
# Choose network from [devnet, testnet, mainnet, local, custom | default: devnet]: testnet
# Enter private key as a hex literal (0x...) [Current: None | default: Generate new key]: 
# Account a1b2c3d4... doesn't exist, creating it and funding it with 100000000 Octas
```

**Choose testnet** when prompted (testnet is free and safe for learning).

**What you just did**: 
- Created a new Aptos account with a unique address (like `0xa1b2c3d4...`)
- Generated a private key (keep this secret!)
- Got free testnet APT tokens for gas

### Check Your Account

```bash
# Check your account details
aptos account list

# Check your APT balance
aptos account list --query balance
```

**What you see**: Your account address and APT balance in "Octas" (1 APT = 100,000,000 Octas).

## Step 2: Understanding Our Contract Structure

Let's look at our bridge escrow contract:

```bash
# Navigate to our contract
cd src/features/multichain/chainwares/aptoswares

# Look at the contract files
ls -la
```

**Key files**:
- `Move.toml` - Contract configuration (like package.json)
- `sources/demos_bridge_escrow_enhanced.move` - Our smart contract code

### Understanding the Contract Address

Open `Move.toml` and you'll see:
```toml
[addresses]
my_addrx = "0x42"
```

**What this means**: Our contract will be deployed at address `0x42`. In production, this would be your real account address.

## Step 3: Your First Contract Deployment

### Compile the Contract

```bash
# Compile our contract
aptos move compile

# You should see:
# INCLUDING DEPENDENCY AptosFramework
# INCLUDING DEPENDENCY AptosStdlib  
# INCLUDING DEPENDENCY MoveStdlib
# BUILDING aptoswares
```

**What happened**: Aptos checked your contract for errors and prepared it for deployment.

### Deploy to Testnet

```bash
# Deploy the contract (replace 0x42 with your actual address)
aptos move publish --named-addresses my_addrx=$(aptos config show-profiles --profile=default | grep 'account' | awk '{print $2}')
```

**What happened**: Your contract is now live on testnet! Anyone can call its functions.

### Verify Deployment

```bash
# Check deployed modules
aptos account list --query modules

# You should see: DemosBridgeEscrowEnhanced
```

## Step 4: Create Test USDC (Since Real USDC Doesn't Exist Yet)

Since our contract needs USDC but real USDC might not exist on testnet, let's create test USDC:

```bash
# Create a test USDC token
aptos move run \
  --function-id 0x1::managed_coin::initialize \
  --type-args "address::TestUSDC" \
  --args string:"Test USDC" string:"TUSDC" u8:6 bool:false

# Register yourself to receive TUSDC
aptos move run \
  --function-id 0x1::managed_coin::register \
  --type-args "$(aptos config show-profiles --profile=default | grep 'account' | awk '{print $2}')::TestUSDC"

# Mint 1,000,000 TUSDC for yourself (6 decimals = 1,000,000 * 10^6)
aptos move run \
  --function-id 0x1::managed_coin::mint \
  --type-args "$(aptos config show-profiles --profile=default | grep 'account' | awk '{print $2}')::TestUSDC" \
  --args address:$(aptos config show-profiles --profile=default | grep 'account' | awk '{print $2}') u64:1000000000000
```

**What you just did**: Created your own test USDC token and gave yourself 1 million of them.

## Step 5: Initialize Your Bridge Escrow

Now let's initialize our bridge escrow contract:

```bash
# Get your address for convenience
export MY_ADDRESS=$(aptos config show-profiles --profile=default | grep 'account' | awk '{print $2}')

# Initialize the bridge escrow with yourself as authorized
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::initialize \
  --args \
    "vector<address>:[${MY_ADDRESS}]" \
    u64:1000000 \
    u64:100000000000 \
    u64:10000000000000 \
    u64:100000000000000 \
    u64:10
```

**Parameters explained**:
- `vector<address>:[${MY_ADDRESS}]` - You are the authorized Demos address
- `u64:1000000` - Minimum bridge: 1 USDC (6 decimals)
- `u64:100000000000` - Maximum bridge: 100,000 USDC
- `u64:10000000000000` - Max hourly volume: 10M USDC
- `u64:100000000000000` - Max daily volume: 100M USDC  
- `u64:10` - Fee: 0.1% (10 basis points)

**What happened**: Your bridge escrow is now initialized and ready to accept liquidity.

## Step 6: Add Liquidity to Your Escrow

```bash
# Add 10,000 TUSDC to the escrow (10,000 * 10^6 = 10,000,000,000)
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::add_liquidity \
  --args u64:10000000000
```

**What happened**: You deposited 10,000 test USDC into your bridge escrow. It's now available for bridge operations.

### Check Your Escrow Status

```bash
# Check liquidity stats
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_enhanced_stats

# You should see something like:
# Result "10000000000" "0" "10000000000" "0" false
# (total_liquidity, locked_liquidity, available_liquidity, collected_fees, is_paused)
```

**What this means**: 
- Total liquidity: 10,000 USDC
- Locked liquidity: 0 USDC (no active bridges)
- Available liquidity: 10,000 USDC
- Collected fees: 0 USDC
- Is paused: false

## Step 7: Your First Bridge Operation

Now let's simulate a bridge operation. In reality, Demos Network would calculate the required USDC and call this function, but we'll simulate it:

```bash
# Initiate a bridge operation
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::initiate_bridge \
  --args \
    "vector<u8>:bridge_eth_sol_arb_001" \
    address:0x456 \
    "vector<u8>:Solana" \
    "vector<u8>:Arbitrum" \
    "vector<u8>:ETH" \
    "vector<u8>:ETH" \
    u64:2000000000 \
    u64:3600
```

**Parameters explained**:
- `bridge_eth_sol_arb_001` - Unique bridge ID (Demos Network would generate this)
- `0x456` - User address who wants to bridge
- `Solana` → `Arbitrum` - Bridge route
- `ETH` → `ETH` - Asset being bridged
- `2000000000` - Lock 2,000 USDC (calculated by Demos Network's oracle)
- `3600` - 1 hour timeout

**What happened**: You simulated what Demos Network would do - lock 2,000 USDC for a bridge operation. The system also collected a 0.1% fee (2 USDC). Note: Fees are optional and can be set to 0%.

### Check the Bridge Status

```bash
# Check updated liquidity stats
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_enhanced_stats

# Check specific bridge operation
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_bridge_operation \
  --args "vector<u8>:bridge_eth_sol_arb_001"
```

**You should see**: 
- Available liquidity decreased by ~2,002 USDC (2,000 locked + 2 fee)
- Bridge operation details showing status "1" (pending)

## Step 8: Complete the Bridge

Once Demos Network completes the bridge on other chains, it would call the confirm function:

```bash
# Confirm the bridge succeeded
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::confirm_bridge \
  --args "vector<u8>:bridge_eth_sol_arb_001"
```

**What happened**: The 2,000 USDC is now unlocked and available for other bridges. The 2 USDC fee stays collected (though fees are optional and could be 0%).

### Check Final Status

```bash
# Check liquidity stats again
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_enhanced_stats

# Check bridge operation status
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_bridge_operation \
  --args "vector<u8>:bridge_eth_sol_arb_001"
```

**You should see**:
- Available liquidity back to ~9,998 USDC (10,000 - 2 fee)
- Collected fees: 2 USDC
- Bridge status: "2" (confirmed)

## Step 9: Understanding What You Just Did

### Bridge Operation Lifecycle

1. **Price Calculation**: Demos Network (acting as oracle) calculates how much USDC to lock as collateral
2. **Initiate**: Demos Network calls Aptos contract to lock calculated USDC amount
3. **Cross-Chain Execution**: Demos Network performs the actual bridge operations on source/destination chains
4. **Settlement**: Demos Network calls Aptos contract to confirm/fail based on bridge outcome, unlocking USDC

### Key Aptos Concepts You've Learned

**Resources**: Your bridge escrow data is stored as a "resource" at your address. Only you can modify it.

```bash
# View all resources at your address
aptos account list --query resources
```

**Signers**: Only you could call the admin functions because you have the private key to "sign" transactions.

**Events**: Your bridge operations emitted events that can be monitored:

```bash
# View recent events (you might see bridge events)
aptos account list --query events --start 0 --limit 10
```

## Step 10: Try Emergency Functions

Let's test the emergency pause feature:

```bash
# Emergency pause the contract
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::emergency_pause

# Try to initiate a bridge (this should fail)
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::initiate_bridge \
  --args \
    "vector<u8>:should_fail_bridge" \
    address:0x789 \
    "vector<u8>:Ethereum" \
    "vector<u8>:Polygon" \
    "vector<u8>:USDC" \
    "vector<u8>:USDC" \
    u64:1000000000 \
    u64:3600

# You should see an error: "CONTRACT_PAUSED"

# Unpause the contract
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::emergency_unpause
```

**What you learned**: Emergency functions let you stop operations immediately if something goes wrong.

## Step 11: Understand Rate Limits

Try to exceed the rate limits:

```bash
# Check current rate limit status
aptos move view \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_rate_limit_status

# Try to initiate a massive bridge (this should fail if it exceeds your hourly limit)
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::initiate_bridge \
  --args \
    "vector<u8>:big_bridge_test" \
    address:0x789 \
    "vector<u8>:Ethereum" \
    "vector<u8>:Polygon" \
    "vector<u8>:USDC" \
    "vector<u8>:USDC" \
    u64:15000000000000 \
    u64:3600

# This should fail with "RATE_LIMIT_EXCEEDED"
```

## Step 12: Collect Your Fees

As the owner, you can withdraw collected fees:

```bash
# Withdraw the fees you've collected (2 USDC)
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::withdraw_fees \
  --args u64:2000000
```

**What happened**: The 2 USDC in fees is now back in your personal account.

## Step 13: Bridge Expiration

Let's see what happens when a bridge times out:

```bash
# Create a bridge with a very short timeout (60 seconds)
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::initiate_bridge \
  --args \
    "vector<u8>:timeout_test_bridge" \
    address:0x999 \
    "vector<u8>:Bitcoin" \
    "vector<u8>:Ethereum" \
    "vector<u8>:BTC" \
    "vector<u8>:WBTC" \
    u64:1000000000 \
    u64:60

# Wait 60+ seconds, then expire the bridge
sleep 65

# Anyone can expire a timed-out bridge
aptos move run \
  --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::expire_bridge \
  --args "vector<u8>:timeout_test_bridge"
```

**What happened**: After the timeout, the locked USDC was automatically released back to the pool.

## Key Concepts Summary

### What You've Learned About Aptos:

1. **Accounts**: Have addresses, hold tokens, and can deploy contracts
2. **Resources**: Data stored on-chain that only the owner can modify
3. **Signers**: Prove you own an account by signing transactions
4. **Events**: Log important actions for monitoring
5. **Gas**: Pay APT for computational costs
6. **Modules**: Smart contracts that provide functions

### What You've Learned About Our Contract:

1. **Initialization**: Set up the escrow with operational limits
2. **Liquidity Management**: Add/remove USDC for bridge operations
3. **Bridge Lifecycle**: Initiate → Process → Confirm/Fail/Expire
4. **Emergency Controls**: Pause operations if needed
5. **Fee Collection**: Sustainable revenue model
6. **Rate Limiting**: Prevent abuse and manage risk

## Next Steps

Now you understand how the contract works! You can:

1. **Experiment**: Try different bridge scenarios
2. **Monitor**: Watch events and statistics
3. **Integrate**: Build applications that use this contract
4. **Extend**: Add new features or modify existing ones
5. **Deploy**: Move to mainnet when ready for production

## Common Commands Reference

```bash
# View contract functions
aptos move view --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::get_enhanced_stats

# Call contract functions  
aptos move run --function-id ${MY_ADDRESS}::DemosBridgeEscrowEnhanced::function_name --args param1 param2

# Check account resources
aptos account list --query resources

# Check account events
aptos account list --query events

# Check account balance
aptos account list --query balance
```

## Troubleshooting

**"Insufficient funds" error**: Make sure you have enough APT for gas and enough TUSDC for operations.

**"Not authorized" error**: Make sure you're calling from the correct account that's in the authorized list.

**"Module not found" error**: Make sure you deployed the contract successfully and are using the correct address.

**"Function not found" error**: Double-check the function name and module name.

You've now successfully deployed and used a real Aptos smart contract! This hands-on experience gives you the foundation to work with any Aptos contract.