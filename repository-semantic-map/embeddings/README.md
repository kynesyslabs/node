# Embeddings

This index run does not include pre-computed embedding vectors by default.

## Generate embeddings (automated)

This repo includes an embedding generator that produces:
- `repository-semantic-map/embeddings/semantic-fingerprints.npy` (float32 matrix, shape `[atoms, dim]`)
- `repository-semantic-map/embeddings/uuid-mapping.json` (row index → uuid)

### Configure an embedding endpoint

The script supports a **generic HTTP provider** compatible with:
`POST { model, input: string[] } -> { data: [{ embedding: number[] }] }`

Set env vars:
- `EMBED_PROVIDER=http`
- `EMBED_HTTP_ENDPOINT` (required) — full URL to your embeddings endpoint
- `EMBED_HTTP_API_KEY` (optional) — bearer token
- `EMBED_MODEL` (optional) — model name sent in the request
- `EMBED_BATCH_SIZE` (optional, default `64`)

Run:
```bash
bun scripts/semantic-map/embed.ts
```

Outputs:
- `repository-semantic-map/embeddings/semantic-fingerprints.npy`
- `repository-semantic-map/embeddings/uuid-mapping.json`
- `repository-semantic-map/embeddings/meta.json`
