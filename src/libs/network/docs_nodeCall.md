# NodeCall API Documentation

This document outlines the available nodeCall methods and their functionality.

## Methods

### getPeerInfo
Returns information about the current peer.

### getPeerlist
Retrieves the list of connected peers.

### getPreviousHashFromBlockNumber
- `.data`: `{ blockNumber: number }`
- Returns: The hash of the block preceding the given block number.

### getPreviousHashFromBlockHash
- `.data`: `{ hash: string }`
- Returns: The hash of the block preceding the block with the given hash.

### getBlockHeaderByNumber
- `.data`: `{ blockNumber: number }`
- Returns: The header of the block with the given number.

### getBlockHeaderByHash
- `.data`: `{ hash: string }`
- Returns: The header of the block with the given hash.

### getLastBlockNumber
Returns the number of the latest block in the chain.

### getLastBlockHash
Returns the hash of the latest block in the chain.

### getBlockByNumber
- `.data`: `{ blockNumber: number }`
- Returns: The full block data for the given block number.

### getBlockByHash
- `.data`: `{ hash: string }`
- Returns: The full block data for the given block hash.

### getTxByHash
- `.data`: `{ hash: string }`
- Returns: The transaction data for the given transaction hash.

### getMempool
Returns the current mempool (pending transactions).

### getPeerIdentity
Returns the public key of the current peer's identity.

### getAddressInfo
- `.data`: `{ address: string }`
- Returns: Detailed information about the given address.

### getAddressNonce
- `.data`: `{ address: string }`
- Returns: The current nonce for the given address.

### getPeerTime
Returns the current timestamp of the peer.

### getAllTxs
Returns all transactions in the chain.

### hots
Returns a predefined response (likely an Easter egg).

## Error Handling

- If required parameters are missing, methods typically return a 400 status with an error message.
- Internal errors usually result in a 500 status with error details in the `extra` field.

## Response Format

Responses generally follow this structure:

```typescript
{
result: number; // HTTP status code
response: any; // The main response data
require_reply: boolean;
extra: any | null; // Additional information or error details
}
```