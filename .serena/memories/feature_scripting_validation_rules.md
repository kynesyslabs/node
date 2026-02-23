# Token Script Validation Rules - Phase 3.2

## Summary
Phase 3.2 implemented custom validation rules support for token scripts, allowing pre-operation validation of native operations (transfer, mint, burn, approve) with boolean allow/deny logic.

## Implementation Details

### Core Components Added

1. **Validation Types** (`src/libs/scripting/types.ts`)
   - `ValidationRuleType`: `"canTransfer" | "canMint" | "canBurn" | "canApprove"`
   - `ExecuteValidationRequest`: Request structure with tokenAddress, ruleType, args, tokenData
   - `ValidationSuccess`/`ValidationError`: Result types with execution metadata
   - Error types: `rule_not_found`, `execution_error`, `invalid_return`, `timeout`

2. **TokenSandbox Integration** (`src/libs/scripting/TokenSandbox.ts:456-520`)
   - `executeValidation()`: SES compartment execution for validation rules
   - Boolean return type validation (rejects non-boolean returns)
   - Deterministic PRNG seed: `0x76616c69` ("vali" in hex)
   - Same read-only endowments as view functions via `createValidationEndowments()`

3. **ScriptExecutor Integration** (`src/libs/scripting/ScriptExecutor.ts:456-492`)
   - `executeValidation()`: High-level orchestration for validation execution
   - Default-allow behavior when no script exists (operations allowed by default)
   - Token accessor building from GCR data
   - Config merging with sandbox defaults

4. **HookExecutor Integration** (`src/libs/scripting/HookExecutor.ts:37-44, 230-275, 406-431`)
   - **Phase 0: Validation Rule** execution added before all hooks
   - `OPERATION_HOOKS` extended with `validationRule` mapping
   - `buildValidationArgs()`: Converts operation data to validation function arguments
   - Metadata tracking: `validationExecuted` field in `HookExecutionMetadata`
   - Graceful handling: Missing rules allow operation, execution errors log warning but allow

### Execution Flow

```
Native Operation Request
  ↓
Phase 0: Validation Rule Execution
  ├─ canTransfer/canMint/canBurn/canApprove(args)
  ├─ Returns: true (allow) | false (deny)
  ├─ No script → Allow by default
  └─ Execution error → Log warning, allow by default
  ↓
  ├─ true → Continue to Phase 1
  └─ false → REJECT (return HookExecutionResult with rejection)
  ↓
Phase 1: beforeHook
Phase 2: Native Operation
Phase 3: afterHook
```

### Validation Rule Signatures

- `canTransfer(from: string, to: string, amount: bigint): boolean`
- `canMint(to: string, amount: bigint): boolean`
- `canBurn(from: string, amount: bigint): boolean`
- `canApprove(owner: string, spender: string, amount: bigint): boolean`

### Error Handling

- **rule_not_found**: Validation rule doesn't exist → Operation allowed by default
- **execution_error**: Runtime error during validation → Log warning, allow by default
- **invalid_return**: Validation returned non-boolean → Validation fails
- **timeout**: Execution exceeded timeout limit → Validation fails

### Key Design Decisions

1. **Default Allow**: Missing validation rules don't break operations (optional enhancement)
2. **Read-Only**: Validation rules use same endowments as view functions (no state mutations)
3. **Boolean Only**: Must return true/false, enforced with explicit type checking
4. **Pre-Execution**: Run before hooks to provide earliest rejection point
5. **Error Tolerance**: Execution failures allow operation by default (configurable in future)

## Documentation

Comprehensive `VALIDATION_RULES.md` created with:
- System architecture and execution flow diagrams
- All validation rule types and signatures
- 6 example validation rules (whitelist, time-lock, limits, permission-based)
- Usage examples via nodeCall and HookExecutor
- Comparison: Validation Rules vs Hooks
- Error handling for all error types
- Best practices and security considerations
- Future enhancement roadmap

## Related Files

- `src/libs/scripting/types.ts`: Validation type definitions
- `src/libs/scripting/TokenSandbox.ts`: Low-level SES execution
- `src/libs/scripting/ScriptExecutor.ts`: High-level orchestration
- `src/libs/scripting/HookExecutor.ts`: Integration with native operations
- `src/libs/scripting/index.ts`: Public API exports
- `src/libs/scripting/VALIDATION_RULES.md`: Complete documentation

## Last Updated
2026-02-23 - Phase 3.2 completed: Custom validation rules support fully implemented and documented
