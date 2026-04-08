# Scripting Types: SDK vs Node Differences

## Overview

The token scripting system has two parallel type definitions:
- **SDK types** (`sdks/src/types/token/TokenTypes.ts`): For external consumers and API contracts
- **Node types** (`node/src/libs/scripting/types.ts`): For internal implementation

## Key Differences

### StateMutation

**SDK Version** (unified type with discriminator):
```typescript
export interface StateMutation {
    type: "setBalance" | "addBalance" | "subBalance" | "setCustomState" | "setAllowance"
    address?: string        // Target address for balance operations
    spender?: string        // Spender address for allowance operations
    value: string | number | Record<string, unknown>
    key?: string            // Key for custom state operations
}
```

**Node Version** (discriminated union with separate interfaces):
```typescript
export type StateMutation =
    | SetBalanceMutation
    | AddBalanceMutation
    | SubBalanceMutation
    | SetAllowanceMutation
    | SetStorageMutation
    | EmitMutation

export interface SetBalanceMutation {
    type: "setBalance"
    address: string
    value: bigint
}
// ... each type has its own interface with specific required fields
```

**Rationale**: Node uses discriminated unions for type safety during internal processing. SDK uses a looser type for API flexibility.

### ScriptContext

**SDK Version**:
```typescript
export interface ScriptContext {
    caller: string
    method: string
    args: unknown[]
    tokenState: Readonly<TokenState>      // Full state snapshot
    tokenMetadata: Readonly<TokenMetadata> // Full metadata
    txTimestamp: number
    prevBlockHash: string
    blockHeight: number
}
```

**Node Version**:
```typescript
export interface ScriptContext {
    caller: string
    method: string
    args: unknown[]
    timestamp: number      // Named differently (txTimestamp in SDK)
    blockHeight: number
    prevBlockHash: string
    txHash: string         // Additional field for PRNG seeding
    token: TokenStateAccessor  // Accessor interface, not full state
}
```

**Key Differences**:
- Node has `txHash` (used for deterministic PRNG seeding)
- Node uses `TokenStateAccessor` interface instead of raw state objects
- Field naming: `timestamp` vs `txTimestamp`

### ScriptResult / ScriptExecutionResult

**SDK Version**:
```typescript
export interface ScriptExecutionResult {
    success: boolean
    mutations: StateMutation[]
    returnValue?: unknown
    error?: string
    complexity: number  // Gas/complexity metrics
}
```

**Node Version**:
```typescript
export type ScriptResult = ScriptSuccess | ScriptError

export interface ScriptSuccess {
    success: true
    mutations: StateMutation[]
    returnValue?: unknown
    gasUsed: number
    executionTimeMs: number
}

export interface ScriptError {
    success: false
    error: string
    errorType: "timeout" | "gas_limit" | "runtime" | "validation" | "security"
    gasUsed: number
    executionTimeMs: number
}
```

**Key Differences**:
- Node uses discriminated union for success/error
- Node has `errorType` enum for categorized errors
- Node tracks `executionTimeMs` separately
- SDK uses `complexity`, Node uses `gasUsed`

### Additional Node-Only Types

```typescript
// Hook system (Node only)
export type HookType = "beforeTransfer" | "afterTransfer" | "beforeMint" | "afterMint" | "beforeBurn" | "afterBurn"

export interface HookContext {
    hookType: HookType
    caller: string
    timestamp: number
    blockHeight: number
    prevBlockHash: string
    txHash: string
    operation: TransferOperation | MintOperation | BurnOperation
    token: TokenStateAccessor
}

export interface HookResult {
    allow: boolean
    reason?: string
    additionalMutations?: StateMutation[]
    gasUsed: number
    executionTimeMs: number
}

// Sandbox configuration (Node only)
export interface SandboxConfig {
    timeoutMs: number
    maxGas: number
    maxStackDepth: number
    debug: boolean
    enableConsole: boolean
}
```

## Conversion Guidelines

When converting between SDK and Node types:

### SDK → Node (receiving from external):
1. Parse `StateMutation.value` to appropriate Node type (bigint for balances)
2. Add `txHash` to context if not present
3. Build `TokenStateAccessor` from raw state objects

### Node → SDK (sending to external):
1. Convert `bigint` values to `string` for JSON serialization
2. Flatten `errorType` into `error` message if needed
3. Map `gasUsed` to `complexity`

## Last Updated
2026-02-22 - Initial documentation during Phase 2 implementation
