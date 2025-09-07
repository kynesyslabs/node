# Demos Smart Contracts Flow Diagram

## Contract Deployment Flow

```
┌─────────────┐     ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │     │     SDK     │      │     RPC     │      │     GCR     │
└──────┬──────┘     └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                   │                    │                    │
       │ Deploy Contract   │                    │                    │
       │──────────────────>│                    │                    │
       │                   │                    │                    │
       │                   │ CONTRACT_DEPLOY TX │                    │
       │                   │───────────────────>│                    │
       │                   │      📁 Transaction:                    │
       │                   │      ContractDeployTransaction.ts       │
       │                   │                    │                    │
       │                   │                    │ Validate Source    │
       │                   │                    │ (Phase 2)          │
       │                   │      📁 Handler:   │                    │
       │                   │      handleContractDeploy.ts            │
       │                   │      📁 Validator: │                    │
       │                   │      ContractValidator.ts               │
       │                   │                    │                    │
       │                   │                    │ Calculate Fee      │
       │                   │                    │ (Phase 7)          │
       │                   │                    │                    │
       │                   │                    │ Generate Address   │
       │                   │                    │ (Phase 7)          │
       │                   │                    │                    │
       │                   │                    │ Store Contract     │
       │                   │                    │───────────────────>│
       │                   │      📁 Database:  │                    │
       │                   │      GCR_Main.ts   │                    │
       │                   │                    │                    │
       │                   │  Contract Address  │                    │
       │                   │<───────────────────│                    │
       │                   │                    │                    │
       │ Contract Address  │                    │                    │
       │<──────────────────│                    │                    │
       │                   │                    │                    │
```

## Contract Execution Flow

```
┌─────────────┐     ┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   User      │     │     SDK     │      │     RPC     │      │   Sandbox   │      │     GCR     │
└──────┬──────┘     └──────┬──────┘      └──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                   │                    │                    │                    │
       │ Call Method       │                    │                    │                    │
       │──────────────────>│                    │                    │                    │
       │                   │                    │                    │                    │
       │                   │ CONTRACT_CALL TX   │                    │                    │
       │                   │───────────────────>│                    │                    │
       │                   │      📁 Transaction:                    │                    │
       │                   │      ContractCallTransaction.ts         │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Load Contract      │                    │
       │                   │                    │───────────────────────────────────────>│
       │                   │      📁 Handler:   │                    │                    │
       │                   │      handleContractCall.ts              │                    │
       │                   │      📁 Database:  │                    │                    │
       │                   │      GCR_Main.ts   │                    │                    │
       │                   │                    │<───────────────────────────────────────│
       │                   │                    │ Contract Data      │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Create Sandbox     │                    │
       │                   │                    │───────────────────>│                    │
       │                   │      📁 Sandbox:   │ (Phase 4)          │                    │
       │                   │      Sandbox.ts    │                    │                    │
       │                   │      📁 Executor:  │                    │                    │
       │                   │      SandboxExecutor.ts                 │                    │
       │                   │                    │ Execute Method     │                    │
       │                   │                    │───────────────────>│                    │
       │                   │      📁 Context:   │                    │                    │
       │                   │      ExecutionContext.ts                │                    │
       │                   │                    │                    │ Count Calls        │
       │                   │                    │                    │ (Phase 4)          │
       │                   │      📁 Proxy:     │                    │                    │
       │                   │      CallCountingProxy.ts               │                    │
       │                   │                    │                    │                    │
       │                   │                    │                    │ Update State       │
       │                   │                    │                    │ (Phase 5)          │
       │                   │      📁 State:     │                    │                    │
       │                   │      StateManager.ts                    │                    │
       │                   │                    │<───────────────────│                    │
       │                   │                    │ Result + State     │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Calculate Fee      │                    │
       │                   │                    │ (1 + Call Count)   │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Update GCR         │                    │
       │                   │                    │───────────────────────────────────────> │ 
       │                   │                    │                    │                    │
       │                   │  Execute Result    │                    │                    │
       │                   │<───────────────────│                    │                    │
       │                   │                    │                    │                    │
       │ Method Result     │                    │                    │                    │
       │<──────────────────│                    │                    │                    │
       │                   │                    │                    │                    │
```

## Contract Internal Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Contract JSONB Data Structure              │
│               📁 Types: ContractTypes.ts                        │
│               📁 Entity: GCR_Main.ts                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐        │
│  │   metadata    │  │     code      │  │     state     │        │
│  ├───────────────┤  ├───────────────┤  ├───────────────┤        │
│  │ • version     │  │ • source      │  │ • storage     │        │
│  │ • creator     │  │ • abi         │  │ • frozen      │        │
│  │ • createdAt   │  │ • checksum    │  │ • paused      │        │
│  │ • name        │  │               │  │               │        │
│  │ • updatedAt   │  │               │  │               │        │
│  └───────────────┘  └───────────────┘  └───────────────┘        │
│                                                                 │
│  ┌───────────────┐  ┌───────────────┐                           │
│  │    events     │  │     stats     │                           │ 
│  ├───────────────┤  ├───────────────┤                           │
│  │ • name        │  │ • callCount   │                           │
│  │ • args        │  │ • lastExecuted│                           │
│  │ • blockHeight │  │ • gasUsed     │                           │
│  │ • timestamp   │  │ • deployedAt  │                           │
│  │ • txHash      │  │               │                           │
│  └───────────────┘  └───────────────┘                           │
│                                                                 │
│  📁 State Management: StateManager.ts                           │
│  📁 Validation: ContractValidator.ts                            │
│  📁 ABI Types: ContractABI.ts                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Sandbox Execution Context

```
┌─────────────────────────────────────────────────────────────────┐
│                      Bun Worker Thread                          │
│               📁 Main: Sandbox.ts                               │
│               📁 Worker: SandboxExecutor.ts                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────┐              │
│  │            Execution Context                  │              │
│  │           📁 ExecutionContext.ts              │              │
│  ├───────────────────────────────────────────────┤              │
│  │ • sender: string                              │              │
│  │ • contractAddress: string                     │              │
│  │ • blockHeight: number                         │              │
│  │ • timestamp: Date                             │              │
│  │ • value: bigint                               │              │
│  └───────────────────────────────────────────────┘              │
│                           │                                     │
│  ┌────────────────────────┴──────────────────────┐              │
│  │            User Contract Code                 │              │
│  │           📁 ContractBase.ts                  │              │
│  ├───────────────────────────────────────────────┤              │
│  │ class MyContract extends DemosContract {      │              │
│  │   constructor() { ... }                       │              │
│  │   myMethod() { ... }      ← Call Counting     │              │
│  │ }                                             │              │
│  │           📁 CallCountingProxy.ts             │              │
│  └───────────────────────────────────────────────┘              │
│                           │                                     │
│  ┌────────────────────────┴──────────────────────┐              │
│  │             State Manager                     │              │
│  │           📁 StateManager.ts                  │              │
│  ├───────────────────────────────────────────────┤              │
│  │ • Read state from GCR                         │              │
│  │ • Track state changes                         │              │
│  │ • Enforce 64KB limit                          │              │
│  │ • Rollback on error                           │              │
│  │ • Atomic operations                           │              │
│  └───────────────────────────────────────────────┘              │
│                                                                 │
│  Restrictions:                                                  │
│  • No file system access                                         │
│  • No network access                                            │
│  • No process spawning                                          │
│  • 60 second timeout                                            │
│  • Memory limits                                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Fee Calculation Example

```
User calls: contract.complexOperation()
📁 Fee Logic: handleContractCall.ts (line 84: callFee = 1 DEM)
📁 Call Counting: CallCountingProxy.ts
            │
            ├─> complexOperation()         [+1 DEM]
            │   │
            │   ├─> internalHelper1()      [+1 DEM]
            │   │
            │   └─> internalHelper2()      [+1 DEM]
            │       │
            │       └─> validateData()     [+1 DEM]
            │
Total Fee = Base (1 DEM) + Calls (4 DEM) = 5 DEM
📁 Fee Update: handleContractCall.ts (line 192: stats.gasUsed += sandboxResult.gasUsed)
```

---

## Source Code File Reference

### Core Transaction Types
- `../sdks/src/types/blockchain/TransactionSubtypes/ContractDeployTransaction.ts` - Deploy transaction structure
- `../sdks/src/types/blockchain/TransactionSubtypes/ContractCallTransaction.ts` - Call transaction structure

### Transaction Handlers
- `src/libs/network/routines/transactions/handleContractDeploy.ts` - Deploy transaction handler
- `src/libs/network/routines/transactions/handleContractCall.ts` - Call transaction handler

### Contract Types & Validation
- `src/features/contracts/types/ContractTypes.ts` - Core contract data structures
- `src/features/contracts/types/ContractABI.ts` - ABI type definitions  
- `src/features/contracts/validation/ContractValidator.ts` - Contract validation logic

### Execution Environment
- `src/features/contracts/execution/Sandbox.ts` - Main sandbox orchestrator
- `src/features/contracts/execution/SandboxExecutor.ts` - Worker thread executor
- `src/features/contracts/execution/ExecutionContext.ts` - Context injection
- `src/features/contracts/execution/CallCountingProxy.ts` - Fee calculation proxy
- `src/features/contracts/execution/ContractBase.ts` - Base contract class

### State Management (Phase 5) ✅
- `src/features/contracts/execution/StateManager.ts` - State persistence with rollback

### Database
- `src/model/entities/GCRv2/GCR_Main.ts` - Contract storage entity

### Documentation
- `src/features/contracts/CONTRACT_PHASES.md` - Implementation phases
- `src/features/contracts/CONTRACT_DIAGRAM.md` - This diagram