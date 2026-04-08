# Token Script Validation Rules

## Status
This memory is currently a design note, not an implementation record.

The active scripting code in `src/libs/scripting/index.ts` does not expose a dedicated validation-rule execution phase such as `canTransfer`/`canMint`/`canBurn`/`canApprove`, and it should not be documented as having one.

## Current Branch Reality
- Native token operations execute through hooks plus native mutation application in `GCRTokenRoutines`.
- Missing validation-rule functions do not participate in runtime because there is no separate validation-rule dispatcher today.
- Any future validation-rule feature needs an explicit contract for missing rules, execution errors, invalid return values, and timeouts before this memory can claim implementation.

## Documentation Guardrail
If validation rules are introduced later, this memory should only describe behavior that is present in the shipped code path, including whether the runtime is default-allow, default-deny, or fail-closed on execution errors.
