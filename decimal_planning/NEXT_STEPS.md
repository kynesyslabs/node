# Next Steps — Decimal Migration

> Read `LOG.md` first for context. Read `IDEA.md` for the original proposal.

## Immediate (next session, in order)

### 1. Initialize Mycelium tracking
```bash
myc init                          # if not already
myc epic create --title "DEM → OS denomination migration" \
  --description "Migrate SDK + node from DEM (number) to OS (BigInt, 9 decimals). Breaking change, coordinated cutover. See decimal_planning/IDEA.md."
```
Then create one task per phase (0–10) linked to that epic. Use `--priority high` for Phase 0 (foundation), `medium` for the rest. Set blocking deps per the dependency graph in IDEA.md (Phase 1 blocks 3,4,7; Phase 4 blocks 5; Phase 5 blocks 6; everything blocks 8,9,10).

### 2. Run the coherence audit (the work that got interrupted)
Dispatch in parallel:
- **@senior SDK audit** — verify every file path and interface shape claimed in IDEA.md against `/Users/tcsenpai/kynesys/sdks/`. Output: `decimal_planning/audit_sdk.md` with ✅/⚠️/❌/🆕 markers per phase. Specific files to verify are listed in the original prompt (see git history of this session, or rebuild from IDEA.md's phase list).
- **@senior node audit** — IDEA.md is silent on the node side. Audit `/Users/tcsenpai/kynesys/node/src/` for amount handling: where balances are stored, where fees are computed, where transactions are validated/serialized. Output: `decimal_planning/audit_node.md`. Critical question: does the node do its own amount math, or does it just trust SDK-formatted wire data?
- **@junior surface scan** — grep both repos for: `max_cost_dem`, `network_fee`, `rpc_fee`, `additional_fee`, `amount:`, `balance:`, `nativeAmount`, `amountExpected`. Output: `decimal_planning/surface_scan.md` — file:line catalog.

### 3. Synthesize refined spec
After all three audits land, write `decimal_planning/SPEC.md` — the implementable version of IDEA.md with:
- Verified file paths (not the doc's guesses)
- Cutover strategy across SDK + node (the doc punts on this)
- Transaction hash/signature impact analysis
- Test strategy (the doc's Phase 9 is thin)
- Rollout order across the two repos

### 4. Only then: start Phase 0
Phase 0 (foundation: constants + conversion utilities + tests) is safe to start in the SDK repo because it's purely additive. Don't touch types or wire format until SPEC.md is approved by user.

## Known risks to flag in SPEC.md
- **Hash/signature break**: `amount: number` → `amount: string` changes serialized bytes. If signatures cover transaction content, all old signed txs become invalid. Need to confirm with user whether this lands at a network reset.
- **JSON.stringify + BigInt**: throws by default. The IDEA.md notes this in Phase 8.2 but doesn't prescribe a serialization layer. SPEC.md must.
- **Node/SDK lockstep**: if SDK ships v(N+1) before node accepts OS strings (or vice versa), every wallet breaks. Need a coordinated release plan.
- **`balance` field type change**: from `number` to `string` is wire-breaking for any existing client.

## Files in this directory
- `IDEA.md` — original user-supplied proposal (do not edit, treat as source-of-record for intent)
- `LOG.md` — running session log
- `NEXT_STEPS.md` — this file
- (future) `audit_sdk.md`, `audit_node.md`, `surface_scan.md`, `SPEC.md`, diagrams

## How to resume
1. Read `AGENTS.md` (confirm Team Mode is still on)
2. Read `decimal_planning/LOG.md` (latest entry)
3. Read `decimal_planning/NEXT_STEPS.md` (this file)
4. Run `myc task list --epic <decimal-epic-id>` to see current state
5. Pick up at the first unchecked item under "Immediate"
