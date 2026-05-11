# Network Configs Editability

After some plan/research I compact all info

## CAN be changed

1. **Minimum validator stake** - entry bar should adjust as network grows
2. **Maximum number of validators** - controls decentralization vs. performance over time
3. **Fees (network, RPC, min transaction)** - need to track real-world costs and token value
4. **Block limits (max transactions, max data size)** - throughput tuning as conditions evolve
5. **Voting parameters (window, activation notice)** - governance should tune itself
6. **Feature flags** - enable/disable features without code deployment

## CANNOT be changed

1. **The 2/3 voting threshold** - a cartel could lower it and take over governance
2. **Genesis wallet balances** - retroactively rewriting history breaks chain integrity
3. **Signing algorithms** - requires actual code changes, not just parameter update
4. **Transaction format** - would break backward compatibility with existing chain data
