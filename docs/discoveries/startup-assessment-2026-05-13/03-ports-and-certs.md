---
type: discovery-slice
title: Port Inventory and TLS/Cert Touchpoints
date: 2026-05-13
---

# Port Inventory and TLS/Cert Touchpoints

## Port Table

| PORT | DEFAULT | SERVICE | PROTO | TLS? | INT.ONLY? | SOURCE |
|---|---|---|---|---|---|---|
| 53550 | `RPC_PORT` | Main HTTP RPC | HTTP | No | No (host-exposed) | `docker-compose.yml:189`, `.env.example:39` |
| 53551 | `OMNI_PORT` | OmniProtocol TCP/TLS (binary RPC) | TCP or TLS | **Conditional** (`OMNI_TLS_ENABLED`) | No (host-exposed) | `docker-compose.yml:190`, `.env.example:49`, `src/libs/omniprotocol/server/TLSServer.ts:104,127` |
| 3005 | `RPC_SIGNALING_PORT` | WebRTC signaling (peer discovery) | WS | No | No (host-exposed) | `docker-compose.yml:191`, `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:101` |
| 3001 | `RPC_MCP_PORT` | MCP server (AI agents) | HTTP | No | No (host-exposed) | `docker-compose.yml:192`, `src/features/mcp/MCPServer.ts:74,327` |
| 9090 | `METRICS_PORT` / `METRICS_HOST_PORT` | Prometheus metrics endpoint on node | HTTP | No | host-exposed | `docker-compose.yml:194`, `src/features/metrics/MetricsService.ts:32` |
| 7047 | `TLSNOTARY_PORT` | TLSNotary sidecar | HTTP (notary protocol) | No | host-exposed | `docker-compose.yml:67`, `.env.example:113`, `src/features/tlsnotary/TLSNotaryService.ts:212` |
| 9091 | `PROMETHEUS_PORT` | Prometheus server | HTTP | No | host-exposed (monitoring profile) | `docker-compose.yml:235`, `.env.example:169` |
| 3000 | `GRAFANA_PORT` | Grafana UI | HTTP | No | host-exposed (monitoring profile) | `docker-compose.yml:258`, `.env.example:164` |
| 9100 | `NODE_EXPORTER_PORT` | Node Exporter | HTTP | No | host-exposed (full profile) | `docker-compose.yml:~270` |
| 7474 | `NEO4J_HTTP_PORT` | Neo4j HTTP | HTTP | No | host-exposed (neo4j profile) | `docker-compose.yml:~278` |
| 7687 | `NEO4J_BOLT_PORT` | Neo4j Bolt | TCP | No | host-exposed (neo4j profile) | `docker-compose.yml:~279` |
| 5432 | `PG_PORT` | Postgres | TCP | No | **Internal-only** (mapping commented) | `docker-compose.yml:49` |
| 5332 | (bare-metal fallback) | Postgres host-mapped legacy | TCP | No | host-exposed if uncommented | `src/config/defaults.ts:24`, `.env.example:67` |
| 10250 | hardcoded `GroundControl.port` | GroundControl info server | HTTP/HTTPS (env-selected) | **Conditional** | Not in compose (in-process only) | `src/libs/utils/demostdlib/groundControl.ts:20,31,86,106` |
| 55000-57000 | `PORT_CONFIG` pool | TLSNotary `wstcp` proxy instances | TCP | No | **NOT in compose ports** — bind only inside container/host | `src/features/tlsnotary/portAllocator.ts:14-20,83`, `TLSNotaryService.ts:662` |
| 0 (ephemeral) | — | web2 Proxy (`Proxy.ts`) | HTTP | No | bind to `0.0.0.0:0` (ephemeral) | `src/features/web2/proxy/Proxy.ts:365` |
| ${PORT}/3000 fallback | `NODE_PORT`/`PORT` | omniprotocol BaseAdapter fallback | TCP | No | internal | `src/libs/omniprotocol/integration/BaseAdapter.ts:143-148`, `startup.ts:196`, `OmniProtocolServer.ts:265` |
| `serverPort` (Config) | — | ActivityPub fediverse | HTTP | No | host? | `src/features/activitypub/fediverse.ts:82-83` |

**Dockerfile EXPOSE** (`Dockerfile:189`): `53550 53551 3005 3001 9090` (5 ports).

## Cert Touchpoints

1. **`src/libs/omniprotocol/server/TLSServer.ts`** (lines 1-150) — Loads `cert`, `key`, optional `ca` via `fs.readFileSync` from `OMNI_CERT_PATH` / `OMNI_KEY_PATH` / `OMNI_CA_PATH` (`config/loader.ts:138-140`). **Fallback**: throws if cert/key missing. `rejectUnauthorized: false` — does custom fingerprint check (`trustedFingerprints` map). Per-port: bound to OMNI port (53551). Gated by `OMNI_TLS_ENABLED` (`envKeys.ts:69`).
2. **`src/libs/utils/demostdlib/groundControl.ts:54-109`** — HTTPS optional via init param `protocol`. Reads `keys.key`, `keys.cert`, `keys.ca` via `fs.readFileSync`. **Fallback**: silently downgrades to HTTP if any cert missing/invalid (`log.warning("Switching to HTTP")`). Port 10250 hardcoded.
3. **TLSNotary sidecar** (`tlsnotary` Docker container, `ghcr.io/tlsnotary/tlsn/notary-server`): manages its own signing key inside container in `docker` mode. In `ffi` mode (`.env.example:121-124`), node uses `TLSNOTARY_SIGNING_KEY` env var. **Not an X.509 cert** — it's a TLSNotary signing key, separate concern.
4. **No HTTPS on:** RPC (53550), MCP (3001), Signaling (3005), Metrics (9090), Prometheus, Grafana, Postgres, Neo4j, fediverse. All cleartext.

## tlsnotary/ folder

`/Users/tcsenpai/kynesys/node/tlsnotary/` contains **only `docker-compose.yml`** — standalone alternative compose. The notary itself runs as a third-party sidecar image; no local cert management needed.

## Existing key/cert files on disk

- `.demos_identity.key` — node identity (Ed25519, not TLS)
- `ipfs_53550/data_53550/ipfs/swarm.key` — IPFS swarm key (not TLS)
- `data/l2ps/example/private.key` — L2PS example (not TLS)

**No `.pem`/`.crt`/`.pfx` shipped.** OMNI TLS certs must be user-provided; absent → TLSServer throws or `OMNI_TLS_ENABLED=false`.

## Quantified Pain

- **Host-exposed ports default profile (monitoring + tlsnotary):** 53550, 53551, 3005, 3001, 9090, 7047, 9091, 3000 = **8 ports**.
- **+ full profile:** +9100 = **9**.
- **+ neo4j profile:** +7474, +7687 = **11**.
- **+ Postgres uncomment:** +5432/5332 = **12**.
- **+ TLSNotary wstcp pool** (if proxy mode binds publicly): up to **2000 more** (55000-57000 range, dynamic).
- **TLS endpoints needing certs today:** only **1** (OmniProtocol 53551) + optionally GroundControl 10250 (HTTP fallback).
- **TLS endpoints user *thinks* need certs:** probably most of them — but currently **only OMNI uses real X.509**.

## Recommendation Hooks (flag-only)

- **Reverse-proxy candidates behind 1 TLS endpoint** (all HTTP/WS, no native TLS): RPC 53550, MCP 3001, Signaling 3005 (WSS upgrade), Metrics 9090, Grafana 3000, Prometheus 9091. → **6 ports collapsible to 1 (443)** via Caddy/Traefik/nginx with single Let's Encrypt cert.
- **Truly P2P / direct exposure required:** OmniProtocol TCP/TLS 53551 (binary protocol, custom fingerprint auth — cannot reverse-proxy without breaking fingerprinting), TLSNotary wstcp pool 55000-57000 (per-session ephemeral, but binds to `0.0.0.0` per `portAllocator.ts:83` — verify whether host exposure is needed or container-internal suffices).
- **Should never be host-exposed in prod:** Postgres 5432 (already commented), Neo4j 7474/7687, Prometheus 9091, Node Exporter 9100, MCP 3001 (AI integration — bind localhost), Signaling 3005 (depends on WebRTC topology), `wstcp` 55000-57000 (verify).
- **GroundControl 10250:** in-process server, not in compose `ports:` — verify it isn't accidentally exposed via host networking.

## wstcp Reachability Verdict (added 2026-05-14, Epic 14 T0)

The 55000-57000 wstcp pool's reachability depends on the deployment mode:

| Deployment | Reachability |
|---|---|
| Containerized via `docker-compose.yml` (default) | **De facto internal only** — bridge network (`docker-compose.yml:287`), no `ports:` mapping for the range, Dockerfile EXPOSE excludes it. The `0.0.0.0` bind inside the container namespace stays inside the container namespace. |
| Bare-metal via `scripts/run` + `README.md:189` `ufw allow 55000:60000/tcp` | **Host-exposed** — wstcp binds the host's `0.0.0.0` directly. |

Implication for Epic 12 T9 (flip wstcp to `127.0.0.1`): only safe in
containerized deployments *with a co-located reverse proxy*. In
bare-metal mode the flip breaks external SDK clients. See
`docs/runbooks/wstcp-reachability-check.md` for the operator one-liner
that confirms the verdict per environment.

## Counts

- **Total distinct ports referenced:** 13 fixed + 2000-port ephemeral pool + ephemeral `:0` + GroundControl 10250.
- **Host-exposed via compose default:** **6** (node service: 53550, 53551, 3005, 3001, 9090) + **1** (tlsnotary 7047) = **7 host ports default**, scales to **11** with all profiles.
- **Dockerfile EXPOSE:** 5.
- **TLS-enabled today:** 1 (OmniProtocol, conditional) + 1 (GroundControl, conditional with silent HTTP fallback).
