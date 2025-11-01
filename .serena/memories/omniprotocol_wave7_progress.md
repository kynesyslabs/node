# OmniProtocol Wave 7 Progress (consensus fixtures)

## Protocol Meta Test Harness
- Bun test suite now isolates Demos SDK heavy deps via per-test dynamic imports and `jest.mock` shims.
- `bun test tests/omniprotocol` now runs cleanly without Solana/Anchor dependencies.
- Tests use dynamic `beforeAll` imports so mocks are registered before loading OmniProtocol modules.

## Consensus Fixture Drops (tshark capture)
- `fixtures/consensus/` contains real HTTP request/response pairs extracted from `http-traffic.json` via tshark.
  - `proposeBlockHash_*.json`
  - `setValidatorPhase_*.json`
  - `greenlight_*.json`
- Each fixture includes `{ request, response, frame_request, frame_response }`. The `request` payload matches the original HTTP JSON so we can feed it directly into binary encoders.
- Source capture script lives in `omniprotocol_fixtures_scripts/mitm_consensus_filter.py` (alternative: tshark extraction script used on 2025-11-01).

## Next
- Use these fixtures to implement consensus opcodes 0x31–0x38 (and related) with round-trip tests matching the captured responses.