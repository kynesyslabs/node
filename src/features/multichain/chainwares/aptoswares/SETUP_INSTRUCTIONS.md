# Demos Bridge Escrow - Deployment & Setup Instructions

## Overview

This guide provides step-by-step instructions for deploying and setting up the Demos Bridge Escrow smart contract on Aptos for cross-chain liquidity management.

## Prerequisites

- **Aptos CLI** installed and configured
- **Node.js/Bun** for testing and integration
- **USDC tokens** on Aptos (or ability to create test tokens)
- **Multisig wallet setup** for Demos authorized addresses

## Step 1: Environment Setup

### 1.1 Install Aptos CLI

```bash
# Install Aptos CLI
curl -fsSL "https://aptos.dev/scripts/install_cli.py" | python3

# Verify installation
aptos --help
```

### 1.2 Initialize Aptos Account

```bash
# Create new account (save the private key securely)
aptos init

# Or use existing account
aptos init --private-key <your-private-key>

# Check account info
aptos account list
```

### 1.3 Fund Account

```bash
# For testnet (get test APT)
aptos account fund-with-faucet --account <your-address>

# For mainnet, transfer APT from another account
```

## Step 2: Token Setup (USDC)

### 2.1 Option A: Use Existing USDC

If USDC already exists on the network:

```bash
# Check USDC token address
aptos account list --query resources --account <usdc-issuer-address>

# Register to receive USDC
aptos account create-resource-account --seed usdc_receiver
```

### 2.2 Option B: Create Test USDC (Testnet Only)

```bash
# Create test USDC token
aptos move run \
  --function-id 0x1::managed_coin::initialize \
  --type-args "TestUSDC" \
  --args string:"Test USDC" string:"TUSDC" u8:6 bool:false

# Mint initial USDC for testing
aptos move run \
  --function-id 0x1::managed_coin::mint \
  --type-args "TestUSDC" \
  --args address:<your-address> u64:1000000000000  # 1M USDC (6 decimals)
```

## Step 3: Contract Compilation

### 3.1 Update Move.toml

```toml
[package]
name = "aptoswares"
version = "0.0.0"

[dependencies]
AptosFramework = { git = "https://github.com/aptos-labs/aptos-core.git", subdir = "aptos-move/framework/aptos-framework", rev = "mainnet" }

[addresses]
my_addrx = "<your-deployment-address>"
std = "0x1"
```

### 3.2 Compile Contract

```bash
# Navigate to contract directory
cd src/features/multichain/chainwares/aptoswares

# Compile the contract
aptos move compile

# Verify compilation success
echo "Contract compiled successfully"
```

## Step 4: Contract Deployment

### 4.1 Deploy to Network

```bash
# Deploy to testnet
aptos move publish --named-addresses my_addrx=<your-address>

# Deploy to mainnet (ensure you have sufficient APT for gas)
aptos move publish \
  --named-addresses my_addrx=<your-address> \
  --url https://fullnode.mainnet.aptoslabs.com/v1 \
  --max-gas 100000
```

### 4.2 Verify Deployment

```bash
# Check deployed modules
aptos account list --query modules --account <your-address>

# Should show: DemosBridgeEscrow module
```

## Step 5: Contract Initialization

### 5.1 Prepare Multisig Addresses

Create a list of authorized Demos addresses:

```javascript
// Example authorized addresses (replace with actual Demos multisig addresses)
const authorizedAddresses = [
  "0x1234...5678",  // Demos Multisig Address 1
  "0x9abc...def0",  // Demos Multisig Address 2
  "0x2468...ace0",  // Demos Multisig Address 3
];
```

### 5.2 Initialize Contract

```bash
# Initialize the bridge escrow
aptos move run \
  --function-id <your-address>::DemosBridgeEscrow::initialize \
  --args "vector<address>:[0x1234567890abcdef,0x9876543210fedcba]"

# Verify initialization
aptos account list --query resources --account <your-address>
```

## Step 6: Initial Liquidity Setup

### 6.1 Register for USDC (if needed)

```bash
# Register your contract to receive USDC
aptos move run \
  --function-id 0x1::managed_coin::register \
  --type-args "<USDC-type-address>::USDC"
```

### 6.2 Add Initial Liquidity

```bash
# Add 100,000 USDC initial liquidity (adjust amount as needed)
aptos move run \
  --function-id <your-address>::DemosBridgeEscrow::add_liquidity \
  --args u64:100000000000  # 100k USDC (6 decimals)
```

### 6.3 Verify Liquidity

```bash
# Check liquidity stats
aptos move view \
  --function-id <your-address>::DemosBridgeEscrow::get_liquidity_stats
```

## Step 7: Access Control Verification

### 7.1 Test Authorization

```bash
# Test that authorized address can initiate bridge (will fail if no liquidity)
# This is just to test the authorization, not actual bridge operation
aptos move run \
  --function-id <your-address>::DemosBridgeEscrow::initiate_bridge \
  --args \
    "vector<u8>:test_bridge_001" \
    "address:0x123" \
    "vector<u8>:Ethereum" \
    "vector<u8>:Solana" \
    "vector<u8>:ETH" \
    "vector<u8>:ETH" \
    u64:1000000000 \
    u64:3600
```

## Step 8: Integration Testing

### 8.1 Create Test Bridge Operation

```javascript
// Example Node.js/TypeScript integration
import { AptosClient, AptosAccount, HexString } from "aptos";

const client = new AptosClient("https://fullnode.testnet.aptoslabs.com/v1");
const account = new AptosAccount(new HexString("your-private-key"));

async function testBridgeOperation() {
  // Initiate bridge
  const payload = {
    type: "entry_function_payload",
    function: `${account.address()}::DemosBridgeEscrow::initiate_bridge`,
    type_arguments: [],
    arguments: [
      "test_bridge_001",           // bridge_id
      "0x456",                     // user_address
      "Ethereum",                  // source_chain
      "Solana",                    // dest_chain
      "ETH",                      // source_asset
      "ETH",                      // dest_asset
      "2000000000",               // lock_amount (2000 USDC)
      "3600"                      // timeout_seconds (1 hour)
    ]
  };

  const txn = await client.generateTransaction(account.address(), payload);
  const signedTxn = await client.signTransaction(account, txn);
  const response = await client.submitTransaction(signedTxn);
  
  console.log("Bridge initiated:", response.hash);
}
```

### 8.2 Monitor Events

```bash
# Monitor contract events
aptos move view \
  --function-id <your-address>::DemosBridgeEscrow::get_bridge_operation \
  --args "vector<u8>:test_bridge_001"
```

## Step 9: Production Configuration

### 9.1 Security Checklist

- [ ] Multisig addresses properly configured
- [ ] Initial liquidity added securely
- [ ] Access controls tested
- [ ] Emergency procedures documented
- [ ] Monitoring and alerting set up

### 9.2 Operational Setup

1. **Monitoring Dashboard**: Set up event monitoring for bridge operations
2. **Alerting System**: Configure alerts for failed bridges, low liquidity, expired operations
3. **Backup Procedures**: Document emergency recovery procedures
4. **Key Management**: Secure storage of multisig private keys

### 9.3 Integration with Demos Network

```javascript
// Demos Network integration architecture
class DemosAptosIntegration {
  constructor(contractAddress, authorizedSigner) {
    this.contractAddress = contractAddress;
    this.signer = authorizedSigner;
  }

  async initiateBridgeLock(bridgeParams) {
    // Demos Network acts as oracle - calculate required USDC liquidity
    const usdcRequired = await this.calculateUSDCRequirement(bridgeParams);
    
    // Generate unique bridge ID
    const bridgeId = `bridge_${Date.now()}_${Math.random()}`;
    
    // Call Aptos contract to lock liquidity
    await this.callContract('initiate_bridge', [
      bridgeId,
      bridgeParams.userAddress,
      bridgeParams.sourceChain,
      bridgeParams.destChain,
      bridgeParams.sourceAsset,
      bridgeParams.destAsset,
      usdcRequired,
      bridgeParams.timeoutSeconds
    ]);

    // Demos Network performs actual cross-chain bridge
    const bridgeResult = await this.performCrossChainBridge(bridgeParams);
    
    // Confirm or fail on Aptos based on result
    if (bridgeResult.success) {
      return await this.confirmBridge(bridgeId);
    } else {
      return await this.failBridge(bridgeId);
    }
  }

  async confirmBridge(bridgeId) {
    // Called after successful cross-chain execution
    return await this.callContract('confirm_bridge', [bridgeId]);
  }

  async failBridge(bridgeId) {
    // Called after failed cross-chain execution
    return await this.callContract('fail_bridge', [bridgeId]);
  }

  async performCrossChainBridge(bridgeParams) {
    // Demos Network handles actual cross-chain communication
    // This is where the real bridge happens on other chains
    return { success: true }; // Simplified
  }
}
```

## Step 10: Maintenance and Upgrades

### 10.1 Regular Monitoring

```bash
# Check liquidity levels daily
aptos move view \
  --function-id <your-address>::DemosBridgeEscrow::get_liquidity_stats

# Monitor expired bridges
# Set up automated expire_bridge calls for timed-out operations
```

### 10.2 Liquidity Management

```bash
# Add liquidity when levels are low
aptos move run \
  --function-id <your-address>::DemosBridgeEscrow::add_liquidity \
  --args u64:<amount>

# Remove excess liquidity if needed (owner only)
aptos move run \
  --function-id <your-address>::DemosBridgeEscrow::remove_liquidity \
  --args u64:<amount>
```

## Troubleshooting

### Common Issues

1. **"Insufficient Liquidity" Error**
   - Check available liquidity: `get_liquidity_stats()`
   - Add more USDC if needed: `add_liquidity()`

2. **"Not Authorized" Error**
   - Verify signer address is in authorized list
   - Check multisig setup

3. **"Bridge Already Exists" Error**
   - Use unique bridge IDs
   - Check existing bridge: `get_bridge_operation()`

4. **Gas Estimation Failures**
   - Increase max gas limit
   - Check account APT balance

### Emergency Procedures

If critical issues occur:
1. Contact contract owner immediately
2. Use emergency functions (if implemented)
3. Document incident for post-mortem
4. Coordinate with Demos Network team

## Support and Resources

- **Aptos Documentation**: https://aptos.dev/
- **Move Language Guide**: https://move-language.github.io/move/
- **Demos Network**: [Contact Information]
- **Contract Source**: `src/features/multichain/chainwares/aptoswares/`

## Version History

- **v1.0.0**: Initial deployment setup guide
- **Future**: Automated deployment scripts, enhanced monitoring tools