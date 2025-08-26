# LiquidityTank Smart Contract

A secure, gasless-enabled multisig liquidity management contract for the Demos Network bridge system.

## 🔐 Security Features

- **Front-running Protection**: Internal proposal ID generation with cryptographic entropy
- **Fee-on-Transfer Token Support**: Dual-balance slippage protection
- **Gasless Transactions**: Contract-sponsored gas payments for zero-cost user experience
- **Multisig Governance**: 2/3 majority approval for all operations
- **Emergency Controls**: Pause/unpause and ownership rotation capabilities

## 📋 Core Functions

### Initialization
```solidity
setAuthorizedAddresses(address[] _addresses)
```
One-time setup of multisig owners (minimum 3 required).

### Multisig Operations
```solidity
multisigTransfer(uint256 nonce, address token, address to, uint256 amount, uint256 slippageBps)
```
Transfer ETH or ERC20 tokens with 2/3 approval requirement.

```solidity
proposeNextOwners(uint256 nonce, address[] newOwners)
```
Rotate multisig ownership with proposal system.

### Gasless System
```solidity
depositGasSubsidy() payable
configureGasSubsidy(bool enabled, uint256 maxSubsidy, uint256 dailyLimit)
reimburseGas(address user) payable
```
Manage the contract-sponsored gas payment system.

### Meta-Transactions
```solidity
executeMetaTransaction(address user, bytes signature, uint256 nonce, address token, address to, uint256 amount, uint256 slippageBps)
```
Execute transactions on behalf of users without requiring ETH for gas.

### Emergency Controls
```solidity
pause() / unpause()
```
Emergency stop/resume functionality (deployer only).

## 📁 Documentation

- [Usage Guide](./USAGE.md) - Integration with ethers.js and @kynesyslabs/demosdk
- [Gasless System](./GASLESS.md) - How contract-sponsored transactions work
- [Testing](./TESTING.md) - Test suite explanation and coverage

## 🚀 Quick Start

1. Deploy contract
2. Call `setAuthorizedAddresses([owner1, owner2, owner3])`
3. Fund contract with ETH for operations
4. Optional: Setup gasless system with `depositGasSubsidy()` and `configureGasSubsidy()`

## 📊 Gas Costs

- First approval: ~254k gas
- Second approval + execution: ~221k gas
- Gasless transactions: Contract pays automatically