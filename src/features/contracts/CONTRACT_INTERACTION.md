# Smart Contract SDK Interaction Guide

This guide explains how to deploy and interact with smart contracts using the Demos SDK.

## Table of Contents
1. [Setup](#setup)
2. [Contract Deployment](#contract-deployment)
3. [Contract Interaction](#contract-interaction)
4. [Advanced Features](#advanced-features)
5. [API Reference](#api-reference)

## Setup

### Installation

```bash
npm install @kynesyslabs/demosdk
# or
yarn add @kynesyslabs/demosdk
# or
bun add @kynesyslabs/demosdk
```

### Initialize SDK

```typescript
import { Demos } from '@kynesyslabs/demosdk'

// Get SDK instance
const demos = Demos.instance

// Connect wallet (using private key or mnemonic)
await demos.connectWallet(privateKey)
// or
await demos.connectFromMnemonic(mnemonic)

// Connect to RPC node
await demos.connect('https://rpc.demo.network')
```

## Contract Deployment

### Basic Deployment

Deploy a smart contract from TypeScript source code:

```typescript
// Define your contract
const contractSource = `
class MyToken extends DemosContract {
    constructor() {
        super()
        this.state.set('totalSupply', 1000000)
        this.state.set('name', 'MyToken')
        this.state.set('symbol', 'MTK')
        this.state.set('balances', {})
        
        // Give all tokens to deployer
        const balances = this.state.get('balances')
        balances[this.sender] = 1000000
        this.state.set('balances', balances)
    }
    
    transfer(to: string, amount: number) {
        const from = this.sender
        const balances = this.state.get('balances')
        
        // Check balance
        if (!balances[from] || balances[from] < amount) {
            this.revert('Insufficient balance')
        }
        
        // Transfer
        balances[from] -= amount
        balances[to] = (balances[to] || 0) + amount
        this.state.set('balances', balances)
        
        // Emit event
        this.emit('Transfer', { from, to, amount })
        return true
    }
    
    balanceOf(address: string) {
        const balances = this.state.get('balances')
        return balances[address] || 0
    }
    
    totalSupply() {
        return this.state.get('totalSupply')
    }
}
`

// Deploy the contract
const contract = await demos.contracts.deploy(contractSource)

console.log('Contract deployed at:', contract.address)
console.log('Deployment transaction:', contract.deploymentTx)
```

### Deployment with Constructor Arguments

```typescript
const contractSource = `
class Storage extends DemosContract {
    constructor(initialValue: string) {
        super()
        this.state.set('value', initialValue)
    }
    
    getValue() {
        return this.state.get('value')
    }
    
    setValue(newValue: string) {
        const oldValue = this.state.get('value')
        this.state.set('value', newValue)
        this.emit('ValueChanged', { oldValue, newValue })
    }
}
`

// Deploy with constructor arguments
const contract = await demos.contracts.deploy(
    contractSource,
    ['Hello, World!'], // Constructor arguments
    {
        metadata: {
            name: 'Storage',
            version: '1.0.0',
            description: 'Simple storage contract'
        }
    }
)
```

### Deploy from Template

```typescript
// Use predefined templates
const token = await demos.contracts.deployTemplate('Token', {
    totalSupply: 1000000
})

const storage = await demos.contracts.deployTemplate('Storage')
```

## Contract Interaction

### Basic Contract Calls

```typescript
// Get contract instance
const contract = await demos.contracts.at('contract_address_here')

// Call contract methods
const balance = await contract.call('balanceOf', ['0x123...'])
console.log('Balance:', balance.result)

// Transfer tokens (state-changing call)
const result = await contract.call('transfer', ['recipient_address', 100])
console.log('Transfer successful:', result.success)
console.log('Transaction hash:', result.transactionHash)
```

### Direct Method Access (Proxy Pattern)

```typescript
// Contract methods can be called directly
const contract = await demos.contracts.at('contract_address')

// These are equivalent:
const balance1 = await contract.call('balanceOf', ['address'])
const balance2 = await contract.balanceOf('address') // Direct call

// Transfer with direct call
const result = await contract.transfer('recipient', 100)
```

### Typed Contracts

For better TypeScript support, define contract interfaces:

```typescript
// Define contract interface
interface IMyToken {
    transfer(to: string, amount: number): Promise<boolean>
    balanceOf(address: string): Promise<number>
    totalSupply(): Promise<number>
    approve(spender: string, amount: number): Promise<boolean>
    allowance(owner: string, spender: string): Promise<number>
}

// Get typed contract instance
const contract = await demos.contracts.at<IMyToken>('contract_address')

// Now you have full type safety
const balance = await contract.balanceOf('address') // returns Promise<number>
const success = await contract.transfer('recipient', 100) // returns Promise<boolean>
```

### Sending Value with Calls

```typescript
// Send DEM with a contract call
const result = await contract.callWithValue(
    'deposit',
    [], // arguments
    1000000, // value in smallest unit
    {
        waitForConfirmation: true
    }
)

// Or using options
const result = await contract.call('purchase', [itemId], {
    value: 1000000, // Send 1 DEM with the call
    gasLimit: 100000
})
```

## Advanced Features

### Batch Operations

Execute multiple contract operations in sequence:

```typescript
const batch = demos.contracts.batch()
    .deploy(tokenContract)
    .call(existingContract, 'initialize', [])
    .call(anotherContract, 'setOwner', [newOwner])
    .deploy(storageContract, ['initial value'])

const results = await batch.execute()

// Check results
results.forEach((result, index) => {
    console.log(`Operation ${index}:`, result.success ? 'Success' : 'Failed')
})
```

### Event Queries

```typescript
// Get contract events
const events = await contract.getEvents({
    eventName: 'Transfer',
    fromBlock: 1000,
    toBlock: 2000,
    limit: 100
})

events.forEach(event => {
    console.log(`Transfer: ${event.args.from} → ${event.args.to}: ${event.args.amount}`)
})
```

### Gas Estimation

```typescript
// Estimate gas before sending transaction
const gasEstimate = await demos.contracts.estimateGas(
    'contract_address',
    'transfer',
    ['recipient', 1000]
)

console.log('Estimated gas:', gasEstimate)

// Use in transaction
const result = await contract.call('transfer', ['recipient', 1000], {
    gasLimit: gasEstimate * 120n / 100n // Add 20% buffer
})
```

### Contract State Access

```typescript
// Get specific state value
const value = await contract.getState('totalSupply')

// Get all state (if supported)
const fullState = await contract.getState()
console.log('Contract state:', fullState)

// Get contract metadata
const metadata = await contract.getMetadata()
console.log('Contract info:', metadata)
```

### Wait for Deployment

```typescript
// Deploy and wait for confirmation
const contract = await demos.contracts.deploy(source, [], {
    waitForConfirmation: true,
    confirmations: 3 // Wait for 3 block confirmations
})

// Check if contract exists at address
const exists = await ContractInstance.waitForDeployment(
    demos,
    'contract_address',
    30000 // timeout in ms
)
```

## API Reference

### Main Methods

#### `demos.contracts.deploy(source, args?, options?)`
Deploy a new smart contract.

**Parameters:**
- `source` (string): TypeScript source code
- `args` (any[]): Constructor arguments
- `options` (ContractDeployOptions): Deployment options

**Returns:** `Promise<ContractInstance>`

#### `demos.contracts.at(address, abi?)`
Get instance of existing contract.

**Parameters:**
- `address` (string): Contract address
- `abi` (ContractABI): Optional ABI for typed access

**Returns:** `Promise<ContractInstance>`

#### `demos.contracts.call(address, method, args?, options?)`
Call a contract method directly.

**Parameters:**
- `address` (string): Contract address
- `method` (string): Method name
- `args` (any[]): Method arguments
- `options` (ContractCallOptions): Call options

**Returns:** `Promise<ContractCallResult>`

### ContractInstance Methods

#### `contract.call(method, args?, options?)`
Call a contract method.

#### `contract.callWithValue(method, args, value, options?)`
Call with DEM value.

#### `contract.getState(key?)`
Get contract state.

#### `contract.getEvents(params?)`
Query contract events.

#### `contract.getMetadata()`
Get contract metadata.

### Options Interfaces

```typescript
interface ContractDeployOptions {
    value?: bigint | number      // DEM to send
    gasLimit?: bigint | number   // Gas limit
    nonce?: number               // Transaction nonce
    waitForConfirmation?: boolean // Wait for confirmation
    confirmations?: number       // Number of confirmations
    metadata?: ContractMetadata  // Contract metadata
    validateSource?: boolean     // Validate source code
}

interface ContractCallOptions {
    value?: bigint | number      // DEM to send
    gasLimit?: bigint | number   // Gas limit
    nonce?: number               // Transaction nonce
    waitForConfirmation?: boolean // Wait for confirmation
    confirmations?: number       // Number of confirmations
}

interface ContractCallResult<T = any> {
    success: boolean
    result?: T
    error?: string
    gasUsed?: bigint
    events?: Array<{
        name: string
        args: Record<string, any>
    }>
    transactionHash?: string
    blockHeight?: number
}
```

## Error Handling

```typescript
try {
    const contract = await demos.contracts.deploy(source)
    const result = await contract.call('transfer', ['recipient', 100])
    
    if (!result.success) {
        console.error('Call failed:', result.error)
    }
} catch (error) {
    console.error('Deployment failed:', error.message)
}
```

## Best Practices

1. **Always validate source code** before deployment
2. **Use typed contracts** for better development experience
3. **Estimate gas** before sending transactions
4. **Wait for confirmations** for important transactions
5. **Handle errors gracefully** in production code
6. **Use batch operations** for multiple related calls
7. **Check wallet connection** before operations
8. **Test contracts thoroughly** before mainnet deployment

## Security Considerations

1. **Banned APIs**: The following are not allowed in contracts:
   - `eval`, `Function`, `setTimeout`, `setInterval`
   - `XMLHttpRequest`, `fetch`, `WebSocket`, `Worker`

2. **Size Limits**: Contracts must be under 256KB

3. **State Changes**: Only allowed in non-view methods

4. **Access Control**: Implement proper access controls in contracts

5. **Input Validation**: Always validate user inputs

## Examples Repository

For more examples, see the contracts test directory:
`src/features/contracts/tests/`

## Troubleshooting

### Common Issues

1. **"Wallet not connected"**
   - Ensure you call `demos.connectWallet()` before contract operations

2. **"Contract not found"**
   - Verify the contract address is correct
   - Ensure the contract is deployed on the connected network

3. **"Insufficient balance"**
   - Check your account has enough DEM for the transaction
   - Consider gas costs in addition to value sent

4. **"Method not found"**
   - Verify the method name is correct
   - Check the method is public in the contract

5. **"Transaction timeout"**
   - Network may be congested
   - Try increasing gas price
   - Check RPC connection status