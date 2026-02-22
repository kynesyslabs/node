# Query API

**Index version:** 1.0.1
**Git ref:** `67d37a2c`

Artifacts:
- `repository-semantic-map/semantic-index.jsonl` (JSONL atoms)
- `repository-semantic-map/code-graph.json` (nodes/edges graph)
- `repository-semantic-map/manifest.json` (metadata + stats)

## Basic retrieval (JSONL)

Examples using `jq`:
```bash
jq -r 'select(.semantic_fingerprint.intent_vectors[]? == "consensus") | .code_location.file_path + ":" + (.code_location.line_range[0]|tostring) + " " + (.code_location.symbol_name//"")' repository-semantic-map/semantic-index.jsonl | head
```

## Query patterns

```yaml
Query Patterns:
  - "Where is consensus implemented?"
    -> Search: intent_vectors contains "consensus" + level in [L2,L3]
    -> Return: `src/libs/consensus/v2/PoRBFT.ts` + callers in `src/utilities/mainLoop.ts`

  - "How does the RPC server route requests?"
    -> Search: intent_vectors contains "rpc" + file_path contains "src/libs/network"
    -> Return: chain from `server_rpc.ts` to per-method managers

  - "Which code touches process.env?"
    -> Search: implementation_details.external_integrations contains entries starting with "env:"
    -> Return: env-bound code paths (ports, keys, feature toggles)

  - "What depends on the consensus routine?"
    -> Graph traversal: find symbol 'consensusRoutine' -> called_by depth 2
```

## Notes

- `calls` edges are conservative: only intra-file identifier calls are linked.
- `depends_on` includes a symbol -> module edge plus module import edges where resolvable.

## Index stats (this run)

```json
{
  "total_atoms": 2471,
  "total_edges": 3262,
  "exported_atoms": 2101,
  "files_indexed": 369,
  "confidence_avg": 0.7535936867665043,
  "min_confidence": 0.7,
  "max_confidence": 0.92
}
```
