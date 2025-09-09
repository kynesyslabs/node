# Smart Contracts Architecture - Demos Network

## Pipeline Architecture ✅

### Storage Strategy: Original TypeScript
**Decision**: Store original TypeScript source in GCR database after validation.

**Benefits**:
- ✅ **Transparency**: Contract source code remains readable for auditing
- ✅ **Storage efficiency**: TypeScript is more compact than compiled JavaScript
- ✅ **Simplicity**: No pre-compilation step needed
- ✅ **Runtime capability**: Bun Workers can handle TypeScript compilation at execution time
- ✅ **Debugging**: Much easier to debug TypeScript than compiled JavaScript

### Contract Deployment Flow
```
User → SDK → RPC → handleContractDeploy.ts → GCR Database
```

**Process**:
1. Validate TypeScript source with `validateContractSource()`
2. Generate deterministic contract address: `hash(creatorPubkey + nonce + sourceCodeHash)`
3. Store original TypeScript source in GCR database as JSONB
4. Calculate deployment fee: 1 DEM per 32KB
5. Return contract address to user

### Contract Execution Flow  
```
User → SDK → RPC → handleContractCall.ts → Sandbox.ts → SandboxExecutor.ts
```

**Process**:
1. Load original TypeScript source from GCR database
2. Create Bun Worker with SandboxExecutor.ts
3. SandboxExecutor compiles TypeScript on-the-fly if needed
4. Execute contract method in sandboxed environment (60s timeout)
5. Apply state changes via StateManager and return results

### Technical Architecture

#### Database Design
- **Storage**: Contracts stored as JSONB in existing GCR_Main entity (account-based model)
- **No separate table**: Leverages existing account infrastructure
- **Contract column**: Added to GCR_Main.ts entity

#### Security & Limits
- **Contract size**: 256KB source code maximum
- **Storage limit**: 64KB per contract state
- **Execution timeout**: 60 seconds maximum
- **Banned APIs**: fs, network, process, eval - enforced in sandbox
- **Worker isolation**: Full Bun Worker sandboxing

#### Fee Structure
- **Deployment**: 1 DEM per 32KB of source code
- **Execution**: 1 DEM base + 1 DEM per method call
- **View/pure calls**: Free (no state changes)

#### State Management
- **Atomic operations**: State backup before execution
- **Rollback capability**: Automatic rollback on execution errors
- **Size validation**: 64KB maximum per contract
- **Persistence**: Integrated with GCR update operations

### SandboxExecutor TypeScript Handling
```typescript
// Runtime TypeScript preprocessing
if (source.includes("import") && source.includes("export")) {
    jsSource = source
        .replace(/import\s+.*?\s+from\s+['"'].*?['"];?\s*/g, "")
        .replace(/export\s+/g, "")
}
```

**Capabilities**:
- ✅ Runtime TypeScript compilation by Bun
- ✅ Clean import/export handling
- ✅ Safe execution in worker environment
- ✅ Call counting proxy for fee calculation

## Architecture Status: ✅ OPTIMIZED
Complete pipeline storing original TypeScript for transparency while maintaining efficient runtime execution with full sandbox security.