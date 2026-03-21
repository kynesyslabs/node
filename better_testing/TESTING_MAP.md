# Testing Map

This is the quick visual view of the test harness.

## Runner Map

```text
                           ┌──────────────────────┐
                           │  bun run testenv:doctor │
                           └──────────┬───────────┘
                                      │
                                      v
                    ┌────────────────────────────────────┐
                    │ Is the local devnet healthy enough? │
                    └───────────────┬─────────────────────┘
                                    │
                  yes               │                no
                                    │
                                    v
                      ┌─────────────────────────────┐
                      │ Rebuild / restart as needed │
                      └───────────────┬─────────────┘
                                      │
                                      v
            ┌──────────────────────────────────────────────────────┐
            │ bun run testenv:startup:local -- --build-first       │
            │ cold boot, health, peer discovery, block production  │
            └───────────────┬──────────────────────────────────────┘
                            │
                            v
      ┌─────────────────────────────────────────────────────────────────────┐
      │ Choose the validation goal                                          │
      └───────┬───────────────────┬───────────────────┬─────────────────────┘
              │                   │                   │
              v                   v                   v
  ┌────────────────────┐  ┌───────────────────┐  ┌──────────────────────┐
  │ testenv:cluster    │  │ testenv:prod-gate │  │ testenv:l2ps:local   │
  │ operational health │  │ must-pass release │  │ L2PS live validation │
  └─────────┬──────────┘  └─────────┬─────────┘  └──────────┬───────────┘
            │                       │                       │
            └──────────────┬────────┴──────────────┬────────┘
                           │                       │
                           v                       v
                ┌──────────────────────┐  ┌──────────────────────┐
                │ testenv:perf:baseline│  │  testenv:soak:local  │
                │ active-core baseline │  │ mixed active soak    │
                └──────────────────────┘  └──────────────────────┘

One-off path:

  better_testing/scripts/run-scenario.sh <scenario> [--build] [--env KEY=VALUE]
```

## Coverage Map

```text
ACTIVE + IMPLEMENTED + COUNTED
──────────────────────────────
 petri consensus (186 unit tests, bun run test:petri)
 native tx
 GCR / identity
 consensus
 peer sync / discovery
 multichain / XM
 omni
 ZK
 TLSNotary
 Web2 / DAHR
 IM
 FHE
 incentives
 MCP
 L2PS
 storage handler mocked surface

HISTORICAL OR EXCLUDED FROM ACTIVE COVERAGE
───────────────────────────────────────────
 token scenario family
 native bridge paths
 storageProgram placeholder behavior
 contract-runtime / storage-contract stubs
 deferred demosdk concurrency work
```

## Read This With

- `better_testing/README.md`
- `docs/references/active-feature-test-coverage-matrix.md`
