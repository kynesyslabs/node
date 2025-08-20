# Demos Smart Contracts Flow Diagram

## Contract Deployment Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │     SDK     │     │     RPC     │     │     GCR     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                    │                    │
       │ Deploy Contract   │                    │                    │
       │──────────────────>│                    │                    │
       │                   │                    │                    │
       │                   │ CONTRACT_DEPLOY TX │                    │
       │                   │───────────────────>│                    │
       │                   │                    │                    │
       │                   │                    │ Validate Source    │
       │                   │                    │ (Phase 2)          │
       │                   │                    │                    │
       │                   │                    │ Calculate Fee      │
       │                   │                    │ (Phase 7)          │
       │                   │                    │                    │
       │                   │                    │ Generate Address   │
       │                   │                    │ (Phase 7)          │
       │                   │                    │                    │
       │                   │                    │ Store Contract     │
       │                   │                    │───────────────────>│
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
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │     SDK     │     │     RPC     │     │   Sandbox   │     │     GCR     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                    │                    │                    │
       │ Call Method       │                    │                    │                    │
       │──────────────────>│                    │                    │                    │
       │                   │                    │                    │                    │
       │                   │ CONTRACT_CALL TX   │                    │                    │
       │                   │───────────────────>│                    │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Load Contract      │                    │
       │                   │                    │───────────────────────────────────────>│
       │                   │                    │                    │                    │
       │                   │                    │<───────────────────────────────────────│
       │                   │                    │ Contract Data      │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Create Sandbox     │                    │
       │                   │                    │───────────────────>│                    │
       │                   │                    │ (Phase 4)          │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Execute Method     │                    │
       │                   │                    │───────────────────>│                    │
       │                   │                    │                    │                    │
       │                   │                    │                    │ Count Calls        │
       │                   │                    │                    │ (Phase 4)          │
       │                   │                    │                    │                    │
       │                   │                    │                    │ Update State       │
       │                   │                    │                    │ (Phase 5)          │
       │                   │                    │                    │                    │
       │                   │                    │<───────────────────│                    │
       │                   │                    │ Result + State     │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Calculate Fee      │                    │
       │                   │                    │ (1 + Call Count)   │                    │
       │                   │                    │                    │                    │
       │                   │                    │ Update GCR         │                    │
       │                   │                    │───────────────────────────────────────>│
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
│                         Contract JSONB                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │   metadata    │  │     code      │  │     state     │       │
│  ├───────────────┤  ├───────────────┤  ├───────────────┤       │
│  │ • version     │  │ • source      │  │ • storage     │       │
│  │ • creator     │  │ • abi         │  │ • frozen      │       │
│  │ • createdAt   │  │ • checksum    │  │ • paused      │       │
│  │ • name        │  │               │  │               │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐                          │
│  │    events     │  │     stats     │                          │
│  ├───────────────┤  ├───────────────┤                          │
│  │ • name        │  │ • callCount   │                          │
│  │ • args        │  │ • lastExecuted│                          │
│  │ • blockHeight │  │ • gasUsed     │                          │
│  │ • timestamp   │  │  (future)     │                          │
│  └───────────────┘  └───────────────┘                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Sandbox Execution Context

```
┌─────────────────────────────────────────────────────────────────┐
│                      Bun Worker Thread                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────┐              │
│  │            Execution Context                   │              │
│  ├───────────────────────────────────────────────┤              │
│  │ • sender: string                              │              │
│  │ • contractAddress: string                     │              │
│  │ • blockHeight: number                         │              │
│  │ • timestamp: Date                             │              │
│  │ • value: bigint                               │              │
│  └───────────────────────────────────────────────┘              │
│                           │                                      │
│  ┌────────────────────────┴──────────────────────┐              │
│  │            User Contract Code                 │              │
│  ├───────────────────────────────────────────────┤              │
│  │ class MyContract extends DemosContract {      │              │
│  │   constructor() { ... }                       │              │
│  │   myMethod() { ... }      ← Call Counting    │              │
│  │ }                                             │              │
│  └───────────────────────────────────────────────┘              │
│                           │                                      │
│  ┌────────────────────────┴──────────────────────┐              │
│  │             State Manager                     │              │
│  ├───────────────────────────────────────────────┤              │
│  │ • Read state from GCR                         │              │
│  │ • Track state changes                         │              │
│  │ • Enforce 64KB limit                          │              │
│  │ • Revert on error                             │              │
│  └───────────────────────────────────────────────┘              │
│                                                                  │
│  Restrictions:                                                   │
│  • No file system access                                         │
│  • No network access                                             │
│  • No process spawning                                           │
│  • 60 second timeout                                             │
│  • Memory limits                                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Fee Calculation Example

```
User calls: contract.complexOperation()
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
```