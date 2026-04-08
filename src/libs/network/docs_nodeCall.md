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

### getBlocks  
- `.data`: `{ start: number | 'latest', limit: number }`  
- Returns all blocks by the given range, from end of the table. 

### getTransactions  
- `.data`: `{ start: number | 'latest', limit: number }`  
- Returns all transactions by the given range, from end of the table. 


### hots
Returns a predefined response (likely an Easter egg).

---

## Token Methods (Phase 1.6)

### token.get
Get complete token information by address.
- `.data`: `{ tokenAddress: string }`
- Returns: Token with metadata/state/access control.

### token.getCommitted
Committed-only variant of `token.get` (state as applied from finalized blocks/sync).
- `.data`: `{ tokenAddress: string }`
- Returns: Same shape as `token.get`.
- May return: `409 { error: "STATE_IN_FLUX" }` while the node is applying committed state (sync/consensus). Retry.

### token.getBalance
Get balance of a specific address for a token.
- `.data`: `{ tokenAddress: string, address: string }`
- Returns: Balance info including `balance` (string).

### token.getBalanceCommitted
Committed-only variant of `token.getBalance`.
- `.data`: `{ tokenAddress: string, address: string }`
- Returns: Same shape as `token.getBalance`.
- May return: `409 { error: "STATE_IN_FLUX" }` while the node is applying committed state (sync/consensus). Retry.

### token.getHolderPointers
Get token holder pointers recorded for an address (used by loadgen consistency checks).
- `.data`: `{ address: string }`
- Returns: `{ address: string, tokens: Array<{ tokenAddress: string, ... }>|string[] }`

### token.callView
Execute a read-only script method (view function) on a token.
- `.data`: `{ tokenAddress: string, method: string, args?: any[] }`
- Returns: On success: `{ tokenAddress, method, value, executionTimeMs, gasUsed }`
- On error: `{ error: string, message: string, gasUsed?, executionTimeMs? }`
- Error codes: `INVALID_REQUEST` (400), `TOKEN_NOT_FOUND` (404), `NO_SCRIPT` (400), `EXECUTION_ERROR` (400), `INTERNAL_ERROR` (500)

### token.callViewCommitted
Committed-only variant of `token.callView`.
- `.data`: `{ tokenAddress: string, method: string, args?: any[] }`
- Returns: Same shape as `token.callView`.
- May return: `409 { error: "STATE_IN_FLUX" }` while the node is applying committed state (sync/consensus). Retry.

---

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
