# Security policy

## Reporting a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/kynesyslabs/node/security/advisories/new)
(Security tab, "Report a vulnerability"). Only the maintainers see the
report. Do not open a public issue, pull request or discussion for a
vulnerability, and do not test it against mainnet or another operator's node.

Include the affected version or commit, the steps or a proof of concept, and
what an attacker gains. A report about the SDK goes to
[kynesyslabs/sdks](https://github.com/kynesyslabs/sdks/security/advisories/new).

## What happens next

- We acknowledge the report within 3 days and give a first severity
  assessment within 7 days.
- A fix for a Critical or High issue ships to the validators first, as a
  signed release, before the details are published. The advisory is made
  public once more than two thirds of the active validators run the fix
  (`docs/runbooks/private-patch.md`).
- We credit the reporter in the advisory unless they ask not to be named.

## Severity

| Severity | Examples |
|---|---|
| Critical | Loss or theft of funds, minting or burning outside the rules, a change to the total supply, exposure of validator or release keys, two conflicting blocks finalised at one height |
| High | Halting the chain or stopping blocks from finalising, a remote crash of every validator, bypassing a consensus rule without loss of funds |
| Medium | Denial of service against a single node or its RPC, a crash that needs a specific node setup |
| Low | Everything else with a security impact |

A network halt is High: it stops the chain but loses no funds, and the chain
recovers through the procedure in `docs/runbooks/chain-halt-recovery.md`.

## Rewards

There is no public bounty programme yet. Valid Critical and High reports are
rewarded case by case until one is announced.

## Supported versions

Only the release that mainnet validators run receives security fixes.
