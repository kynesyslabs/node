# Scripting Module Architecture

## Summary
The `src/libs/scripting/` module provides secure, deterministic script execution for token operations using SES (Secure EcmaScript) sandbox technology.

## Key Components

### TokenSandbox (`TokenSandbox.ts`)
Low-level SES compartment management:
- `initialize()` - Locks down JS primordials via SES
- `execute(code, context, config)` - Runs script in isolated compartment
- `executeHook(hookCode, hookType, context, config)` - Runs hooks for native operations
- `validateMutations()` - Structural validation of mutations
- Deterministic PRNG via `createSeededRandom()` using prevBlockHash + txHash

### ScriptExecutor (`ScriptExecutor.ts`)
High-level orchestration service:
- `executeMethod(request)` - Main entry point for consensus layer
- `executeHook(request)` - Hook execution for native operations
- `validateMutationsAgainstToken()` - Business rule validation
- Builds ScriptContext from ExecuteMethodRequest
- Merges config with defaults

Key types:
- `BlockContext` - height, prevBlockHash, timestamp
- `ExecuteMethodRequest` - tokenAddress, method, args, caller, blockContext, txHash, tokenData
- `ExecuteHookRequest` - hookCode, hookType, hookContext, tokenData

### MutationApplier (`MutationApplier.ts`)
Pure functions for applying mutations:
- `applyMutations(tokenData, mutations)` - Main apply function
- Returns `MutationApplicationResult` with newState, events, mutationsApplied
- Immutable - creates deep copy before modifications
- Utility functions: `isEmitMutation()`, `getStateMutations()`, `getEventMutations()`

### TokenStateAccessorBuilder (`TokenStateAccessorBuilder.ts`)
Builds read-only state accessors:
- `buildTokenStateAccessor(data)` - Full accessor for scripts
- `buildMinimalAccessor()` - Minimal accessor for testing

### Types (`types.ts`)
Core type definitions:
- `ScriptContext` - caller, method, args, timestamp, blockHeight, prevBlockHash, txHash, token
- `StateMutation` - Union of SetBalance, AddBalance, SubBalance, SetAllowance, SetStorage, Emit
- `ScriptResult` - ScriptSuccess | ScriptError
- `HookContext`, `HookResult` - Hook-specific types

## Execution Flow

```
ExecuteMethodRequest
       │
       ▼
ScriptExecutor.executeMethod()
       │
       ├─▶ buildTokenStateAccessor(tokenData)
       │
       ├─▶ Build ScriptContext
       │
       ├─▶ tokenSandbox.execute(code, context, config)
       │       │
       │       └─▶ SES Compartment execution
       │           Returns StateMutation[]
       │
       ├─▶ validateMutationsAgainstToken()
       │       (Business rule validation)
       │
       └─▶ Return ScriptResult
               │
               ▼
         applyMutations(tokenData, result.mutations)
               │
               └─▶ MutationApplicationResult
                   (newState, events, mutationsApplied)
```

### HookExecutor (`HookExecutor.ts`)
Native operation hook orchestrator:
- `executeWithHooks(request)` - Main entry for consensus layer
- Execution flow: beforeHook → native mutations → afterHook
- Rejection handling with rollback on afterHook failure
- Utility functions: `createTransferMutations()`, `createMintMutations()`, etc.

See `arch_hook_system` memory for detailed hook architecture.

## Last Updated
2026-02-22 - Phase 2.4 completion (added HookExecutor)
