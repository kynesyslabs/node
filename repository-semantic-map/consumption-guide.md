# Consumption Guide

**Index version:** 1.0.2
**Git ref:** `a454f37e`

## Maintenance protocol

On each re-index:
1. Compute changed files via `git diff --name-only <prevRef>..<newRef>`.
2. Re-run generator; in a future iteration, restrict parsing to affected modules and update `versioning/deltas/`.
3. Re-scan generated artifacts for leaked secrets before committing.

Current mode: full re-index (fast enough for this repo), patch version bump on each run.
