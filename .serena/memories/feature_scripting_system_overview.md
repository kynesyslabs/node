# Token Scripting System - Complete Overview

## Summary
Complete TypeScript scripting system for Demos Network GCRv2 tokens, enabling custom logic execution during consensus with sandboxed security, hooks system, view functions, and validation rules.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Token Operation Request                   │
│         (transfer, mint, burn, approve, view)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Script Execution Flow                   │
│                                                              │
│  Phase 0: Validation Rule (if native operation)             │
│    ├─ canTransfer/canMint/canBurn/canApprove                │
│    └─ Returns: true (allow) | false (deny)                  │
│                                                              │
│  Phase 1: beforeHook (if native operation)                  │
│    ├─ beforeTransfer/beforeMint/beforeBurn/beforeApprove    │
│    └─ Returns: { proceed, mutations, modifiedData }         │
│                                                              │
│  Phase 2: Native Operation / View Function                  │
│    ├─ Native: Apply balance/supply changes                  │
│    └─ View: Execute read-only computation                   │
│                                                              │
│  Phase 3: afterHook (if native operation)                   │
│    ├─ afterTransfer/afterMint/afterBurn/afterApprove        │
│    └─ Returns: { proceed, mutations, modifiedData }         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Final State + Events
```

## Core Components

### 1. Token Sandbox (`TokenSandbox.ts`)
**Purpose**: Low-level SES (Secure ECMAScript) compartment execution

**Key Methods**:
- `executeHook()`: Execute before/after hooks with full endowments
- `executeView()`: Execute view functions with read-only endowments
- `executeValidation()`: Execute validation rules with boolean return enforcement

**Security Features**:
- Isolated SES compartments with hardened endowments
- Deterministic PRNG with operation-specific seeds
- Timeout protection (default: 1000ms)
- Gas/resource tracking
- Mutation detection for view functions

### 2. Script Executor (`ScriptExecutor.ts`)
**Purpose**: High-level orchestration for script execution

**Key Methods**:
- `executeHook()`: Orchestrates hook execution with context building
- `executeView()`: Orchestrates view function execution
- `executeValidation()`: Orchestrates validation rule execution
- `getScriptCode()`: Extracts script code from token data

**Responsibilities**:
- Build token state accessors from GCR data
- Construct script contexts with deterministic data
- Coordinate with TokenSandbox for execution
- Handle script code extraction and validation

### 3. Hook Executor (`HookExecutor.ts`)
**Purpose**: Native operation orchestration with hooks and validation

**Execution Flow**:
1. **Phase 0**: Execute validation rule (canTransfer/canMint/canBurn/canApprove)
   - If validation fails → Reject operation immediately
   - If no validation rule or execution error → Allow by default
2. **Phase 1**: Execute beforeHook
   - Can add mutations or reject operation
3. **Phase 2**: Apply native operation mutations
   - Core balance/supply/allowance changes
4. **Phase 3**: Execute afterHook
   - Can add mutations or reject operation (rare)

**Key Features**:
- Wave-based mutation application
- Proper rejection handling with metadata
- Gas/time tracking across all phases
- Event aggregation from all phases

### 4. Mutation Applier (`MutationApplier.ts`)
**Purpose**: Apply state mutations and generate events

**Mutation Types**:
- `addBalance`: Increase token balance
- `subBalance`: Decrease token balance
- `setAllowance`: Set approval amount
- `setStorage`: Update custom storage
- `emit`: Emit custom events

**Features**:
- Atomic mutation application
- Event generation from mutations
- Balance validation (no negative balances)
- Storage key/value management

## Script Capabilities

### Hook Functions
**Purpose**: Extend native operations with custom logic

**Hook Types**:
- `beforeTransfer(from, to, amount)`: Execute before transfer
- `afterTransfer(from, to, amount)`: Execute after transfer
- `beforeMint(to, amount)`: Execute before mint
- `afterMint(to, amount)`: Execute after mint
- `beforeBurn(from, amount)`: Execute before burn
- `afterBurn(from, amount)`: Execute after burn
- `beforeApprove(owner, spender, amount)`: Execute before approve
- `afterApprove(owner, spender, amount)`: Execute after approve

**Capabilities**:
- Read token state via `context.token.*` methods
- Emit mutations to modify state (balances, storage, events)
- Reject operations by returning `{ proceed: false }`
- Access deterministic context (caller, timestamp, blockHeight)

### View Functions
**Purpose**: Read-only script methods callable via nodeCall (no consensus)

**Characteristics**:
- Pure read-only (mutations rejected)
- Return arbitrary computed values
- Same read-only endowments as validation rules
- Execute via `nodeCall` without consensus

**Example Use Cases**:
- `getCustomData()`: Retrieve computed storage data
- `computeReward(address)`: Calculate rewards for address
- `checkEligibility(address)`: Check custom conditions

### Validation Rules
**Purpose**: Pre-operation boolean gates for native operations

**Rule Types**:
- `canTransfer(from, to, amount)`: Allow/deny transfers
- `canMint(to, amount)`: Allow/deny minting
- `canBurn(from, amount)`: Allow/deny burning
- `canApprove(owner, spender, amount)`: Allow/deny approvals

**Characteristics**:
- Must return boolean (true = allow, false = deny)
- Read-only (same endowments as view functions)
- Execute BEFORE hooks and native operations
- Missing rules default to "allow"

**Example Use Cases**:
- Whitelist-based transfers
- Time-locked operations
- Transfer limits
- Permission-based minting

## Script Context

### Available to Hooks (Full Endowments)
```typescript
context = {
    token: {
        // Read methods
        getBalance(address: string): bigint
        getTotalSupply(): bigint
        getAllHolders(): string[]
        getMetadata(): TokenMetadata
        isPaused(): boolean
        getAllowance(owner: string, spender: string): bigint
        getStorage(key: string): unknown
    },
    
    // Transaction context
    caller: string           // Address initiating operation
    method: string          // Operation name (transfer, mint, etc)
    args: unknown[]         // Operation arguments
    timestamp: number       // Block timestamp
    blockHeight: number     // Current block height
    prevBlockHash: string   // Previous block hash
    txHash: string         // Transaction hash
    
    // Mutation system
    emit: {
        addBalance(address: string, amount: bigint): void
        subBalance(address: string, amount: bigint): void
        setAllowance(owner: string, spender: string, amount: bigint): void
        setStorage(key: string, value: unknown): void
        event(name: string, data: Record<string, unknown>): void
    },
    
    // Utilities
    Math: { ...Math, random: deterministicRandom }
    JSON: JSON
    console: console (if debug enabled)
    BigInt: BigInt
}
```

### Available to View Functions and Validation Rules (Read-Only Endowments)
```typescript
context = {
    token: {
        // Read-only methods (same as hooks)
        getBalance(address: string): bigint
        getTotalSupply(): bigint
        getAllHolders(): string[]
        getMetadata(): TokenMetadata
        isPaused(): boolean
        getAllowance(owner: string, spender: string): bigint
        getStorage(key: string): unknown
    },
    
    // Utilities (no emit methods)
    Math: { ...Math, random: deterministicRandom }
    JSON: JSON
    console: console (if debug enabled)
    BigInt: BigInt
}
```

## Security & Determinism

### SES Compartment Isolation
- Hardened JavaScript execution environment
- No access to host APIs or globals
- Only provided endowments available
- Prevents prototype pollution and escape

### Deterministic PRNG
- Operation-specific seeds for Math.random()
- Hook seed: `0x686f6f6b` ("hook")
- View seed: `0x76696577` ("view")
- Validation seed: `0x76616c69` ("vali")
- Ensures consistent execution across nodes

### Resource Limits
- Timeout protection: 1000ms default (configurable)
- Gas tracking: ~10 gas per millisecond
- Memory limits via compartment constraints
- Execution context isolation

### Mutation Validation
- View functions: Mutations rejected with error
- Validation rules: Boolean return type enforced
- Hooks: Mutations validated before application
- Balance constraints: No negative balances allowed

## Integration Points

### With GCRv2 Token System
- Token data extracted via `getTokenDetails()`
- Script code stored in `details.content.token.script.code`
- Mutations applied to token state after validation
- Events emitted and logged during consensus

### With Network Layer
- Hooks execute during transaction processing (consensus)
- View functions execute via nodeCall (no consensus)
- Validation rules execute during operation validation (consensus)
- Results affect transaction outcome and state changes

### With SDK (`@kynesyslabs/demosdk`)
- `demos.tokens.transfer()`: Triggers beforeTransfer/afterTransfer hooks + canTransfer validation
- `demos.tokens.mint()`: Triggers beforeMint/afterMint hooks + canMint validation
- `demos.tokens.burn()`: Triggers beforeBurn/afterBurn hooks + canBurn validation
- `demos.tokens.approve()`: Triggers beforeApprove/afterApprove hooks + canApprove validation
- `demos.tokens.view()`: Executes view functions via nodeCall (planned)

## Documentation Files

- `HOOKS.md`: Complete hooks system documentation
- `VALIDATION_RULES.md`: Validation rules documentation
- Memory: `feature_scripting_view_functions.md`: View functions documentation
- Memory: `arch_scripting_module_structure.md`: Module architecture
- Memory: `pattern_scripting_types_sdk_vs_node.md`: Type patterns

## Implementation Status

### Completed Features ✅
- ✅ Phase 0: Foundation (Types, Endowments, Token Accessor)
- ✅ Phase 1: SES Sandbox (Compartment execution, PRNG, Timeout)
- ✅ Phase 2: Hook System (Before/After hooks, Mutation system)
- ✅ Phase 3.1: View Functions (Read-only execution, Mutation rejection)
- ✅ Phase 3.2: Validation Rules (Pre-operation gates, Boolean enforcement)
- ✅ Phase 3.3: token.callView nodeCall handler (SDK integration)
- ✅ Phase 4.1: Script Upgrade Mechanism (handleUpgradeTokenScript, version tracking)
- ✅ Phase 4.2: ACL Management (grantPermission, revokePermission, TokenPermissions)
- ✅ Phase 5.1: Script Execution in Consensus (HookExecutor integration)
- ✅ Phase 5.2: Custom Script Methods (handleCustomMethod, executeMethod)

### All Core Scripting Phases Complete! 🎉

### Phase 6: Script Debugging Tools ⏳
- ⏳ Phase 6.1: Script Dry-Run Endpoint (execute without state changes)
- ⏳ Phase 6.2: Gas Profiler (detailed gas breakdown by operation)
- ⏳ Phase 6.3: Script Validator (static analysis for common errors)
- ⏳ Phase 6.4: Debug Console Integration (captured console.log in dev mode)

### Optional/Future Enhancements ⏳
- ⏳ Phase 3.4: Example view functions and validation rules (documentation/samples)
- ⏳ Advanced gas metering and resource limits

## Example Token Script

```typescript
// Token with fees, rewards, and validation
function beforeTransfer(from: string, to: string, amount: bigint) {
    // 1% fee on transfers
    const fee = amount / 100n;
    const netAmount = amount - fee;
    
    context.emit.subBalance(from, fee);
    context.emit.addBalance("0xFeeCollector", fee);
    context.emit.event("TransferFee", { from, amount: fee });
    
    return { proceed: true, mutations: [], modifiedData: { netAmount } };
}

function afterTransfer(from: string, to: string, amount: bigint) {
    // Reward recipient with bonus tokens
    const bonus = amount / 20n; // 5% bonus
    context.emit.addBalance(to, bonus);
    context.emit.event("TransferBonus", { to, amount: bonus });
    
    return { proceed: true, mutations: [] };
}

function canTransfer(from: string, to: string, amount: bigint): boolean {
    // Whitelist validation
    const whitelist = context.token.getStorage("whitelist") as string[] || [];
    return whitelist.includes(from) && whitelist.includes(to);
}

function getReward(address: string): bigint {
    // View function: compute reward without state changes
    const balance = context.token.getBalance(address);
    const totalSupply = context.token.getTotalSupply();
    const rewardPool = context.token.getStorage("rewardPool") as bigint || 0n;
    
    return (balance * rewardPool) / totalSupply;
}
```

## Last Updated
2026-02-23 - Updated with Phase 3.3 token.callView nodeCall handler implementation
