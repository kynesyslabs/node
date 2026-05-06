# Network Configs Editability — v2

> Updated after adversarial peer review to align with stackable_genesis_system_v2.md

## CAN be changed (via on-chain governance)

1. **Minimum validator stake** — entry bar should adjust as network grows
2. **Maximum number of validators** — controls decentralization vs. performance over time
3. **Fees (network, RPC, min transaction)** — need to track real-world costs and token value
4. **Block limits (max transactions, max data size)** — throughput tuning as conditions evolve
5. **Voting parameters (window, activation notice)** — governance should tune itself
6. **Feature flags** — enable/disable features without code deployment

> **Note:** All changeable parameters have **dual-layer safety bounds** enforced at
> validation time: no single proposal can change a value by more than 50%, and absolute
> floors are set at 1% of genesis values. These bounds are themselves non-upgradeable.
> See `stackable_genesis_system_v2.md` for the full bounds table.

## CANNOT be changed (immutable protocol constants)

1. **The 2/3 voting threshold** — a cartel could lower it and take over governance
2. **Genesis wallet balances** — retroactively rewriting history breaks chain integrity
3. **Signing algorithms** — requires actual code changes, not just parameter update
4. **Transaction format** — would break backward compatibility with existing chain data
5. **Safety bounds** — the min/max limits on governable parameters are non-upgradeable
