# Token Scripting System - Phase 2 Complete

## Components Implemented

### Phase 2.1: Sandbox Runtime (TokenSandbox)
- SES (Secure EcmaScript) compartment isolation
- Deterministic execution with seeded PRNG
- Resource limits (timeout, gas tracking)
- Hardened endowments (Math, Date, context, token accessor)
- Hook execution support

### Phase 2.2: Type Definitions (types.ts)
- `ScriptContext`: Execution context (caller, method, args, timestamp, etc.)
- `ScriptResult`: Discriminated union (ScriptSuccess | ScriptError)
- `StateMutation`: Discriminated union of 6 mutation types:
  - `setBalance`, `addBalance`, `subBalance`
  - `setAllowance`, `setStorage`, `emit`
- `HookContext`, `HookResult`, `HookType` for native operation hooks
- `SandboxConfig`, `TokenStateAccessor`, `TokenMetadata`

### Phase 2.3: Script Executor Service
- **ScriptExecutor** (`ScriptExecutor.ts`):
  - `executeMethod()`: Orchestrates script execution
  - `executeHook()`: Runs hooks for native operations
  - `validateMutationsAgainstToken()`: Business rule validation
  - Builds context, delegates to TokenSandbox, validates mutations

- **MutationApplier** (`MutationApplier.ts`):
  - `applyMutations()`: Immutable state transformation
  - Handles all 6 mutation types
  - Collects emitted events
  - Helper utilities: `isEmitMutation()`, `getStateMutations()`, `getEventMutations()`

### Phase 2.4: Token State Accessor Builder
- `buildTokenStateAccessor()`: Builds read-only accessor from GCRTokenData
- `buildMinimalAccessor()`: Lightweight accessor for simple operations

## Architecture Flow

```
Token Transaction
       │
       ▼
ScriptExecutor.executeMethod()
       │
       ├─► buildTokenStateAccessor(tokenData)
       │
       ├─► tokenSandbox.execute(scriptCode, context)
       │         │
       │         ├─► SES Compartment
       │         │     • Deterministic Math.random
       │         │     • Fixed Date.now()
       │         │     • Read-only token accessor
       │         │
       │         └─► Returns StateMutation[]
       │
       ├─► validateMutationsAgainstToken(mutations)
       │
       └─► Return ScriptResult
               │
               ▼
         applyMutations(tokenData, mutations)
               │
               └─► MutationApplicationResult { newState, events }
```

## Key Design Decisions

1. **Immutability**: MutationApplier creates deep copies; original state unmodified
2. **Discriminated Unions**: StateMutation uses type field for exhaustive switch/case
3. **Validation Layers**: TokenSandbox validates structure; ScriptExecutor validates business rules
4. **GCRTokenData**: Single source of truth in TokenStateAccessorBuilder
5. **Event Collection**: EmitMutation doesn't modify state, just collects events

## Files Created/Modified

- `src/libs/scripting/ScriptExecutor.ts` - High-level executor service
- `src/libs/scripting/MutationApplier.ts` - Mutation application
- `src/libs/scripting/index.ts` - Module exports
- `src/libs/scripting/types.ts` - Type definitions
- `src/libs/scripting/TokenSandbox.ts` - SES sandbox
- `src/libs/scripting/TokenStateAccessorBuilder.ts` - Accessor builder
