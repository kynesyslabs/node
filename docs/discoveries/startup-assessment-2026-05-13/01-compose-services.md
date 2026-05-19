---
type: discovery-slice
title: Docker Compose Service Map
date: 2026-05-13
---

# Docker Compose Service Map

Source: `/Users/tcsenpai/kynesys/node/docker-compose.yml` + `.env.example`.

## Service Table

| # | Service | Image | Profile | Restart | Network |
|---|---------|-------|---------|---------|---------|
| 1 | postgres | postgres:16-alpine | none (always) | unless-stopped | demos-network |
| 2 | tlsnotary | ghcr.io/tlsnotary/tlsn/notary-server:v0.1.0-alpha.12 | tlsnotary | unless-stopped | demos-network |
| 3 | node | `${IMAGE_NAME:-demos-node}:${IMAGE_TAG:-local}` (build: .) | none (always) | unless-stopped | demos-network |
| 4 | prometheus | prom/prometheus:v2.48.0 | monitoring | unless-stopped | demos-network |
| 5 | grafana | grafana/grafana:10.2.2 | monitoring | unless-stopped | demos-network |
| 6 | node-exporter | prom/node-exporter:v1.7.0 | full | unless-stopped | demos-network |
| 7 | neo4j | neo4j:5.21 | neo4j | unless-stopped | demos-network |

**Total services: 7.**

## Per-Service Detail

### 1. postgres
- Ports: none exposed (commented out `${PG_HOST_PORT:-5332}:5432`)
- Volumes: `pgdata:/var/lib/postgresql/data`
- depends_on: none
- Healthcheck: `pg_isready -U $PG_USER -d $PG_DATABASE`, interval 5s, timeout 5s, retries 10
- Env (DB): POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB

### 2. tlsnotary
- Ports: `${TLSNOTARY_PORT:-7047}:7047`
- depends_on: none
- Healthcheck: `bash -c "exec 3<>/dev/tcp/127.0.0.1/7047"`, interval 10s, timeout 5s, retries 3, start_period 10s
- Env (TLS): NS_NOTARIZATION__MAX_SENT_DATA
- Note: `platform: linux/amd64` pinned

### 3. node
- Ports: RPC_PORT (53550), OMNI_PORT (53551), RPC_SIGNALING_PORT (3005), RPC_MCP_PORT (3001), METRICS_HOST_PORT:9090
- Volumes: `node_data:/app/data`, `node_logs:/app/logs`, `node_state:/app/state`
- depends_on: postgres (`service_healthy`), tlsnotary (`service_started`, `required: false`)
- Healthcheck: **NONE in compose** (Dockerfile has one, see slice 04)
- Env (grouped):
  - DB: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE
  - RPC: RPC_PORT, EXPOSED_URL, OMNI_ENABLED, OMNI_PORT, OMNI_MODE, RPC_SIGNALING_PORT, RPC_MCP_PORT
  - P2P: IDENTITY_FILE, PEER_LIST_FILE
  - TLS: TLSNOTARY_ENABLED, TLSNOTARY_HOST, TLSNOTARY_PORT, TLSNOTARY_MODE, TLSNOTARY_FATAL, TLSNOTARY_SIGNING_KEY
  - OTHER: METRICS_ENABLED, METRICS_PORT, METRICS_HOST, LOG_LEVEL, PROD, L2PS_ZK_ENABLED, SOLANA_RPC, ETHERSCAN_API_KEY, HELIUS_API_KEY, NOMIS_API_KEY, NOMIS_CLIENT_ID, RAPID_API_KEY, GITHUB_TOKEN, DISCORD_BOT_TOKEN, HUMAN_PASSPORT_API_KEY

### 4. prometheus
- Ports: `${PROMETHEUS_PORT:-9091}:9090`
- Volumes: `./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro`, `prometheus_data:/prometheus`
- depends_on: none
- Healthcheck: **NONE**
- Env: none (CLI flags; retention via `PROMETHEUS_RETENTION`)

### 5. grafana
- Ports: `${GRAFANA_PORT:-3000}:3000`
- Volumes: `grafana_data:/var/lib/grafana` + 5 RO bind-mounts (provisioning, ini, branding assets)
- depends_on: prometheus (no condition — implicit `service_started`)
- Healthcheck: **NONE**
- Env (OTHER): GF_SECURITY_ADMIN_USER, GF_SECURITY_ADMIN_PASSWORD, GF_USERS_ALLOW_SIGN_UP, GF_SERVER_ROOT_URL, GF_INSTALL_PLUGINS, GF_ANALYTICS_*, GF_USERS_DEFAULT_THEME, GF_AUTH_ANONYMOUS_ENABLED, GF_BRANDING_*, GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH, GF_FEATURE_TOGGLES_ENABLE, GF_NEWS_NEWS_FEED_ENABLED, GF_SECURITY_DISABLE_GRAVATAR, GF_DATE_FORMATS_*

### 6. node-exporter
- Ports: `${NODE_EXPORTER_PORT:-9100}:9100`
- Volumes: `/proc:/host/proc:ro`, `/sys:/host/sys:ro`, `/:/rootfs:ro`
- depends_on: none
- Healthcheck: **NONE**

### 7. neo4j
- Ports: `${NEO4J_HTTP_PORT:-7474}:7474`, `${NEO4J_BOLT_PORT:-7687}:7687`
- Volumes: `neo4j_data:/data`, `neo4j_logs:/logs`
- depends_on: none
- Healthcheck: **NONE**
- Env (DB): NEO4J_AUTH, NEO4J_ACCEPT_LICENSE_AGREEMENT

## Aggregates

- **Services WITHOUT healthcheck (5):** node, prometheus, grafana, node-exporter, neo4j
- **Services WITHOUT depends_on (5):** postgres, tlsnotary, prometheus, node-exporter, neo4j (all start independently)
- **Services mounting docker socket:** NONE
- **`privileged: true`:** NONE

## Smells

- **Hardcoded default passwords visible** (.env.example defaults baked into compose via `${VAR:-default}`):
  - `PG_PASSWORD=demospassword`, `PG_USER=demosuser`
  - `GRAFANA_ADMIN_PASSWORD=demos`, `GRAFANA_ADMIN_USER=admin`
  - `NEO4J_AUTH=neo4j/changeme-please`
- **node has no compose-level healthcheck** despite being the central app.
- **grafana depends_on prometheus without `condition`** — legacy short-form, only waits for container start, not readiness.
- **`METRICS_PORT` pinned to 9090 inside container** (scrape target hard-coded in `prometheus.yml`); only host-side remappable.
- **node tlsnotary dep uses `required: false`** — silently dropped when profile is off.
- **`EXPOSED_URL` default `http://localhost:53550`** — useless for real peers.

## Network Topology

Single bridge network `demos-network` (driver: bridge, explicit `name:`). **All 7 services share it** — flat L2 topology, no segmentation. Internal DNS resolves service names (`postgres`, `tlsnotary`, `prometheus`) used in app config.

## Volumes

All named, `demos_` prefix: `demos_pgdata`, `demos_node_data`, `demos_node_logs`, `demos_node_state`, `demos_prometheus_data`, `demos_grafana_data`, `demos_neo4j_data`, `demos_neo4j_logs`. Names pinned with `name:` to prevent project-prefix drift.

## .env.example ↔ Compose Coupling

`.env.example` feeds: PG_*, RPC_PORT, EXPOSED_URL, OMNI_*, RPC_SIGNALING_PORT, RPC_MCP_PORT, IDENTITY_FILE, PEER_LIST_FILE, METRICS_*, TLSNOTARY_* (5), LOG_LEVEL, PROD, L2PS_ZK_ENABLED, COMPOSE_PROFILES (default `monitoring,tlsnotary`), IMAGE_NAME/TAG, GRAFANA_*, PROMETHEUS_PORT, plus 9 optional API keys.

Critical coupling: `TLSNOTARY_ENABLED` must track presence of `tlsnotary` in `COMPOSE_PROFILES` or node logs noisy warnings.
