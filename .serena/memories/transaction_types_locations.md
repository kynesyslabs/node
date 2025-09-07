# Transaction Types and SDK Integration

## Contract Transaction Types

### SDK Source (../sdks/):
- **ContractCallTransaction**: `../sdks/src/types/blockchain/TransactionSubtypes/ContractCallTransaction.ts`
- **ContractDeployTransaction**: `../sdks/src/types/blockchain/TransactionSubtypes/ContractDeployTransaction.ts`
- **Main Transaction Union**: `../sdks/src/types/blockchain/Transaction.ts` (includes ContractCallTransaction and ContractDeployTransaction)

### Installed Package (@kynesyslabs/demosdk v2.3.20):
- **Available in node**: `node_modules/@kynesyslabs/demosdk/types/blockchain/TransactionSubtypes/`
  - `ContractCallTransaction.d.ts` ✅
  - `ContractDeployTransaction.d.ts` ✅
- **Transaction Union**: `node_modules/@kynesyslabs/demosdk/types/blockchain/Transaction.d.ts` includes both contract types

### Node Integration:
- **Transaction Routing**: `src/libs/network/endpointHandlers.ts` 
  - `case "contractCall":` → calls `handleContractCall()`  
  - `case "contractDeploy":` → calls `handleContractDeploy()`
- **Handlers**: 
  - `src/libs/network/routines/transactions/handleContractCall.ts`
  - `src/libs/network/routines/transactions/handleContractDeploy.ts`

## Bridge Transaction Types

### SDK Source (../sdks/):
- **Bridge transactions**: Located in `../sdks/src/types/blockchain/TransactionSubtypes/`
  - `BridgeDepositTransaction.ts`
  - `BridgeWithdrawTransaction.ts` 
  - `BridgeInitiationTransaction.ts`

### Installed Package (@kynesyslabs/demosdk v2.3.20):
- **Available in node**: `node_modules/@kynesyslabs/demosdk/types/blockchain/TransactionSubtypes/`
  - `BridgeDepositTransaction.d.ts` ✅
  - `BridgeWithdrawTransaction.d.ts` ✅
  - `BridgeInitiationTransaction.d.ts` ✅

## Transaction Flow Pattern

1. **SDK Types** → Defines transaction structure and types
2. **Transaction Submission** → RPC receives transaction with `type` field  
3. **endpointHandlers.ts** → Routes based on `transaction.type` in switch statement
4. **Handler Functions** → Specific handlers in `src/libs/network/routines/transactions/`
5. **Integration** → Handlers import types from `@kynesyslabs/demosdk` package