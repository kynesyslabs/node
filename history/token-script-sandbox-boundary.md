# Token Script Sandbox Boundary

## Scope

This note captures the current risk behind PR review task `#135` and defines the minimum implementation target for a future fix. It is intentionally a design and hardening note only. No executor replacement is implemented here.

Relevant review thread:

- CodeRabbit inline: <https://github.com/kynesyslabs/node/pull/695#discussion_r2982508722>

Primary implementation file today:

- `src/libs/scripting/index.ts`

## Current State

Token scripts currently execute in-process through Node's `vm` module.

Observed behavior in `src/libs/scripting/index.ts`:

- `compileScript()` creates a `vm` context with a best-effort sandbox object.
- The hardening step disables `Date.now`, `Math.random`, `globalThis.process`, and `globalThis.require`.
- `runExportedFunctionInVm()` executes exported views, hooks, and methods inside that context with a timeout.
- Script hooks now receive cloned inputs, and cached live VM contexts were already removed in earlier remediations.

Those earlier fixes reduced state leakage and host-object mutation risk, but they did not create a real security boundary.

## Findings

### 1. `node:vm` is not a trust boundary

The current model still runs untrusted token code inside the same Node.js process as consensus-critical logic. Even with a restricted global object and per-call timeout, this is not isolation-grade.

Practical consequence:

- a script bug, abuse path, or runtime escape affects the host process directly
- the consensus process and the script process share the same event loop and memory budget
- hardening is policy-based, not containment-based

### 2. Current protections are mostly determinism guards

The existing measures mainly address replay determinism and obvious ambient access:

- disabling `Date.now`
- disabling `Math.random`
- removing `process`
- removing `require`
- enforcing compile/call timeouts

These measures are useful, but they do not provide:

- process isolation
- memory ceilings
- a hard kill boundary
- ABI-level validation on every crossing
- defense against engine/runtime escape classes

### 3. Denial-of-service remains in scope

Because execution is in-process, token scripts can still threaten node stability through:

- CPU exhaustion
- memory pressure
- async abuse and stalled promise behavior
- pathological object graphs and serialization pressure
- engine/prototype abuse that impacts the host runtime

Even when a timeout trips, the code has already been scheduled inside the same trust domain.

### 4. Previous remediations narrowed, but did not remove, the risk

Already-fixed issues:

- `#133`: stopped reusing cached live VM contexts
- `#134`: stopped handing hooks live host-owned objects

These changes were necessary. They are not sufficient to claim sandboxing.

## Minimum Acceptable Future Boundary

The future fix should treat token scripts as untrusted code and execute them outside the consensus process trust boundary.

Minimum requirements:

- separate execution unit from the main node process
- structured-clone or equivalent serialized request/response boundary
- no live host object references across the boundary
- deterministic, explicitly versioned script ABI
- strict execution timeout
- enforceable memory limit
- killable worker/process on timeout or policy violation
- no ambient filesystem, network, `process`, or module loading access
- validated output schema before applying state changes
- fail-closed behavior for consensus-critical paths

## Preferred Direction

Preferred implementation direction:

- isolated executor process or worker dedicated to token script execution

Why this is the preferred baseline:

- it creates a real containment boundary instead of relying on object-level hardening
- it supports hard termination when limits are exceeded
- it narrows the host API to explicit message passing
- it makes policy enforcement testable and auditable

Candidate implementation shapes:

1. child process with explicit IPC protocol
2. dedicated worker/isolate only if it provides enforceable memory/time controls and a narrower trust boundary than current `node:vm`
3. alternate runtime such as a dedicated embedded JS engine, only if operational complexity is justified

The key requirement is not the specific technology. The key requirement is that the main node process must no longer directly host untrusted token execution.

## Proposed Execution ABI

The future executor interface should be explicit and versioned.

Input envelope:

- executor ABI version
- script source or script artifact identifier
- call type: `view`, `method`, `hook`
- method or hook name
- token snapshot
- tx or block context snapshot
- operation payload snapshot
- limits: timeout, memory budget, output size budget

Output envelope:

- success or failure
- validated return value for views/methods
- validated mutation list
- validated storage replacement or patch
- structured rejection/error category
- execution metadata for observability

Rejected outputs should be treated as execution failure, not best-effort partial success.

## Failure Policy

Consensus-critical paths should fail closed.

Required policy:

- malformed executor output rejects the script result
- timeout rejects the script result
- memory breach rejects the script result and terminates the executor unit
- transport/protocol failure rejects the script result
- repeated executor crashes should surface operational health signals

## Suggested Delivery Plan

1. Define the executor ABI and validation rules.
2. Implement a minimal isolated executor prototype behind the existing `ScriptExecutor` interface.
3. Route views, methods, and hooks through the adapter without changing token semantics.
4. Add timeout, memory, and kill-path enforcement.
5. Add regression coverage for malformed output, timeout, crash, and escape-attempt behavior.
6. Remove or explicitly demote the in-process `node:vm` path from production use.

## Acceptance Criteria Draft

The future fix is done when all of the following are true:

- token scripts no longer execute inside the same trust boundary as the main node process
- only serialized, validated data crosses the executor boundary
- executor invocations have enforced timeout and memory ceilings
- timed out or wedged executions can be terminated without relying on cooperative script behavior
- hooks and methods cannot mutate host state except through validated returned mutations or storage updates
- executor outputs are schema-validated before application
- consensus-critical failures are fail-closed
- regression coverage exists for timeout, malformed output, executor crash, and representative sandbox escape attempts

## Non-Goals For This Prep Task

- replacing the current executor
- changing token script semantics
- resolving the linked PR review thread
- claiming that the current `node:vm` path is secure enough
