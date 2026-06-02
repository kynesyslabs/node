---
type: discovery
title: Docker and Deployment Audit
date: 2026-06-02
status: active
slug: security-scan-2026-06-02
---

# 06 — Docker & Deployment

Scope: container images, compose files, entrypoint, and Caddy reverse-proxy
configuration. Read-only audit. No production code or runtime config was
changed. Every issue is filed as a finding under
`SEC-2026-06-02-1NN` (story S10 claims the `100-129` range).

Files reviewed:

- `Dockerfile`
- `docker-compose.yml`
- `docker-compose.proxy.yml`
- `monitoring/docker-compose.yml`
- `tlsnotary/docker-compose.yml`
- `postgres/docker-compose.yml`
- `scripts/docker-entrypoint.sh`
- `monitoring/caddy/Caddyfile`
- `monitoring/caddy/tlsnotary-modes/subpath.caddy`
- `.env.example` (referenced for default values)

Cross-refs: `02-secrets-in-tree.md` (default-cred topic),
`01-exposed-network-surface.md` (port-binding topic),
`04-authentication-and-authorization.md` (MCP / metrics auth gating).
This file owns the **deployment-level** angle on those topics; finding
bodies link out rather than duplicate.

---

## Image hardening — Dockerfile

What's already good (confirmed, NOT a finding):

- Multi-stage build. Builder layer is discarded.
  (`Dockerfile:21`, `Dockerfile:143`).
- Non-root user `demos` (uid/gid 1000) for the runtime stage
  (`Dockerfile:160-161`, `Dockerfile:217`).
- App tree owned `root:demos` with no group write — runtime user
  cannot rewrite its own binary on RCE (`Dockerfile:175-179`).
- Pinned base image tag `oven/bun:1.3-debian` (not `:latest`)
  (`Dockerfile:21`, `Dockerfile:143`).
- `apt-get` install + `rm -rf /var/lib/apt/lists/*` in same RUN to
  shrink layer cache (`Dockerfile:25-30`, `Dockerfile:152-155`).
- `HEALTHCHECK` hits real `/health` (returns 503 when DB down)
  (`Dockerfile:225-226`).
- `VOLUME` declared for ephemeral state mount points
  (`Dockerfile:215`).
- OCI image labels populated (`Dockerfile:146-149`).

### SEC-2026-06-02-100 — Base image pinned by tag, not digest

Severity: low
CWE: CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)
File: `Dockerfile:21`, `Dockerfile:143`

Both stages reference `oven/bun:1.3-debian` by tag only. Tags are
mutable; the publisher can repoint `1.3-debian` to a different image
without notice. Supply-chain rebuilds would silently pick up a new
base.

Remediation: pin by digest (`oven/bun:1.3-debian@sha256:<digest>`) in
both `FROM` lines and update the digest in a deliberate PR when
upgrading. Same treatment for `postgres:16-alpine`,
`prom/prometheus:v2.48.0`, `grafana/grafana:10.2.2`,
`prom/node-exporter:v1.7.0`, `neo4j:5.21`, `caddy:2-alpine`,
`ghcr.io/tlsnotary/tlsn/notary-server:v0.1.0-alpha.12`.

### SEC-2026-06-02-101 — `bun pm trust --all || true` silently runs every postinstall

Severity: medium
CWE: CWE-1357 (Reliance on Insufficiently Trustworthy Component) / CWE-506
File: `Dockerfile:42`

`bun pm trust --all` executes every `postinstall` script in the dep
tree without filtering. The trailing `|| true` masks failures, so a
malicious dep that throws can never break the build — useful for a
supply-chain attacker because they get exec without leaving a non-zero
exit. Combined with `bun add bufferutil utf-8-validate` on the next
line (`Dockerfile:46`) which re-runs resolution and may pull
transitive updates, this is a broad attack surface.

Remediation: trust an explicit allow-list of packages
(`bun pm trust <pkg>`) rather than `--all`. Drop the trailing
`|| true` or restrict it to a known list of packages that have no
postinstall script. Remove `bun add bufferutil utf-8-validate` and
declare these as direct deps in `package.json` so the lockfile pins
them — otherwise every image build resolves them fresh.

### SEC-2026-06-02-102 — `falcon-sign` patched by `sed` in-image with no integrity check

Severity: low
CWE: CWE-345 (Insufficient Verification of Data Authenticity)
File: `Dockerfile:61-72`

The Dockerfile mutates `falcon-sign/kernel/n3_v1/wasmFile/falcon512.js`
with `sed -i`. There is no upstream version check or hash compare. If
the dep's internal structure changes (e.g. multiple `throw ex;` sites
appear or `console.error` already exists in a different form), the
patch becomes wrong but the build still passes (the script is
idempotent on the *string*, not on the *intent*).

Remediation: pin `falcon-sign` to a known-good version in `package.json`,
hash the target file in the build step, and `exit 1` if the hash drifts
without an explicit acknowledgement. Better: upstream the patch and
remove this in-image surgery.

### SEC-2026-06-02-103 — Runtime image installs `curl` for healthcheck

Severity: informational
CWE: CWE-1104 (Use of Unmaintained Third Party Components) — defence-in-depth
File: `Dockerfile:152-155`, `Dockerfile:226`

`curl` is installed in the runtime image solely to run the
`HEALTHCHECK`. Every CVE in `curl` therefore becomes a CVE in the
runtime image even though the application does not invoke it. The
alternative `wget` (busybox-style) is used by the Grafana / Prometheus
healthchecks; bun itself has `fetch()` so the healthcheck can be
expressed without an external binary.

Remediation: replace the healthcheck with
`["CMD","bun","-e","fetch('http://localhost:'+process.env.RPC_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`
or similar, and drop `curl` from `apt-get install` to shrink the
attack surface.

### SEC-2026-06-02-104 — No `STOPSIGNAL`, no `tini`/dumb-init

Severity: low
CWE: CWE-696 (Incorrect Behavior Order)
File: `Dockerfile:230-231`

`ENTRYPOINT` is a shell script that `exec`s bun. Bun receives SIGTERM
from docker on `docker stop`, but the node has no documented signal
handler beyond Bun's defaults, and `STOPSIGNAL` is not declared. In a
PID 1 context without an init shim, child processes (workers,
TLSNotary sidecar comms) may not get reaped cleanly on shutdown.

Remediation: add `STOPSIGNAL SIGTERM` explicitly, audit
`src/index.ts` for a SIGTERM/SIGINT handler that flushes the chain DB
and the consensus state, and consider `tini` as PID 1 if zombie reaping
becomes an issue under sustained `docker compose restart`.

### SEC-2026-06-02-105 — Build-time `GIT_*` ARGs leak into runtime ENV

Severity: informational
CWE: CWE-200 (Exposure of Sensitive Information)
File: `Dockerfile:188-201`

`GIT_COMMIT`, `GIT_BRANCH`, `GIT_DIRTY`, `BUILT_AT` are baked into the
runtime image as `ENV`. These are surfaced by the
`/version` endpoint (and `/info`). Branch names like
`security-scan-2026-06-02` may leak internal project state to anyone
who can hit RPC. For a public node operator, the commit hash also
fingerprints exact dep versions for vuln-scan triage by an attacker.

Already accepted risk (per `src/utilities/nodeVersion.ts`), but should
be cross-referenced here. Recommend: surface only on
authenticated/sudo endpoints, or coarsen to the release tag.

---

## Compose — `docker-compose.yml` (primary)

### SEC-2026-06-02-106 — Postgres password defaults to `demospassword` even with `PROD=true`

Severity: high
CWE: CWE-798 (Use of Hard-coded Credentials), CWE-1188 (Insecure Default)
File: `docker-compose.yml:47`, `docker-compose.yml:139`, `.env.example:99`

`POSTGRES_PASSWORD: ${PG_PASSWORD:-demospassword}` falls through to
`demospassword` whenever the operator forgets to override `.env`. The
node passes the same default to itself
(`docker-compose.yml:139`). `PROD=true` does NOT gate this — there is
no startup check refusing to boot when the default is detected in
production.

Postgres is internal-only by default (ports commented out at
`docker-compose.yml:59-60`), so the credential is only reachable from
inside the docker bridge — but **anything else on that bridge
(monitoring sidecar, neo4j, future ad-hoc containers) sees it**, and
the operator pattern of uncommenting `- "5332:5432"` for ad-hoc psql
exposes it on the host immediately.

Cross-ref: see `02-secrets-in-tree.md` for the full list of default
creds and the recommended startup-gate pattern. This finding owns the
**docker-compose-specific** angle.

Remediation: refuse to boot when `PROD=true` and any of
`PG_PASSWORD ∈ {demospassword,""}`, `GRAFANA_ADMIN_PASSWORD ∈
{demos,admin,""}`, `NEO4J_AUTH ∈ {neo4j/neo4j,neo4j/changeme-please,""}`.
Implement the gate in `src/config/` (it already loads env) and trip a
loud failure with remediation hint.

### SEC-2026-06-02-107 — All credentials passed via `environment:`, not `secrets:`

Severity: medium
CWE: CWE-214 (Invocation of Process Using Visible Sensitive Information),
CWE-526 (Cleartext Storage of Sensitive Information in Environment Variables)
File: `docker-compose.yml:45-48`, `docker-compose.yml:126-171`,
`docker-compose.yml:267-270`, `docker-compose.yml:355`,
`docker-compose.yml:407-408`

PostgreSQL passwords, Grafana admin password, Neo4j auth tuple,
TLSNotary signing key, third-party API keys (`ETHERSCAN_API_KEY`,
`HELIUS_API_KEY`, `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`,
`HUMAN_PASSPORT_API_KEY`, etc.), and Caddy basic-auth hashes are all
passed through container `environment:` blocks. Consequences:

- Visible to any process inside the container in `/proc/1/environ`.
- Dumped verbatim by `docker inspect <container>` (any local docker
  user reads them).
- Logged by some container runtimes on `OOMKilled` events.
- Inherited by every child process the node spawns.

Compose v2 supports the `secrets:` top-level construct (file- or
swarm-backed) that mounts secrets as in-memory `tmpfs` files at
`/run/secrets/<name>`.

Remediation: migrate at minimum `PG_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`,
`NEO4J_AUTH`, `TLSNOTARY_SIGNING_KEY`, `METRICS_BASIC_AUTH_HASH`,
`MCP_BASIC_AUTH_HASH`, and every third-party API key to compose
`secrets:` with file mounts. Have the node load them from
`/run/secrets/<name>` with `process.env.*` as the legacy fallback.

### SEC-2026-06-02-108 — Metrics bind `0.0.0.0` inside container AND port-published by default

Severity: high
CWE: CWE-668 (Exposure of Resource to Wrong Sphere)
File: `docker-compose.yml:150`, `docker-compose.yml:196`,
`.env.example:122`, `src/features/metrics/MetricsServer.ts`

`METRICS_HOST=0.0.0.0` is the default in `.env.example:122` and is
respected by `MetricsServer` (`src/features/metrics/constants.ts`).
The compose file then publishes `${METRICS_HOST_PORT:-9090}:9090` to
the host unconditionally (`docker-compose.yml:196`). On a fresh
`cp .env.example .env && docker compose up` the operator gets a
**publicly reachable, unauthenticated `/metrics` endpoint** exposing:

- Node identity (peer counts, validator state)
- Chain state (block height, mempool size, consensus round timing)
- Process internals (Prometheus default collectors: memory, GC, FD
  count, syscall histogram — every host detail an attacker would want
  for sizing an exploit).
- Per-route histogram cardinality lets a remote scraper enumerate
  endpoints from outside.

The Caddyfile gates `/metrics` behind basic-auth
(`monitoring/caddy/Caddyfile:93-98`), but **only when the `proxy`
profile is enabled**. Without it, the host port 9090 publication
bypasses Caddy entirely.

Remediation: change the default to `METRICS_HOST=127.0.0.1` in
`.env.example`, OR bind the publish to `127.0.0.1:9090:9090` in
`docker-compose.yml:196`. Prometheus inside the compose network
scrapes `node:9090` over the docker bridge so it does not need the
host publish. Document the change in the proxy runbook.

### SEC-2026-06-02-109 — RPC port published on all interfaces

Severity: medium
CWE: CWE-668 (Exposure of Resource to Wrong Sphere)
File: `docker-compose.yml:180`

`"${RPC_PORT:-53550}:${RPC_PORT:-53550}"` binds `0.0.0.0:53550` by
default. The RPC server itself binds `0.0.0.0` inside the container
(`src/libs/network/bunServer.ts:21`). For a node operator behind a
Caddy proxy, this leaves RPC reachable on the raw host port even after
the proxy is up — bypassing TLS termination and any future
authentication added at the proxy layer.

Cross-ref: `docker-compose.proxy.yml` correctly drops every other host
port mapping when `proxy` profile is active
(`docker-compose.proxy.yml:32-53`) — but RPC is the **one port the
override keeps**. That's a deliberate choice (clients still need to
reach it), but the override does not switch RPC to a loopback bind
either.

Remediation: when the `proxy` profile is on, override RPC port to
`127.0.0.1:53550:53550` in `docker-compose.proxy.yml`. Document a
`PROXY=true → loopback-only RPC` pattern in
`docs/runbooks/proxy-setup.md`.

### SEC-2026-06-02-110 — OmniProtocol publishes on all interfaces in proxy mode

Severity: medium
CWE: CWE-668
File: `docker-compose.proxy.yml:33`, `docker-compose.yml:181`

OmniProtocol (`53551`) is documented as "not proxied — its
custom-fingerprint TLS cannot survive a termination hop"
(`docker-compose.proxy.yml:5-8`), so it remains direct on the host.
That's defensible. **But** the bind is `0.0.0.0`, not the operator's
public NIC, so containers and host services on other interfaces (VPN
tunnel, tailscale) also see it. There is no per-NIC gating.

Remediation: document in `proxy-setup.md` that operators using
multi-NIC hosts should switch the publish to the specific public IP
with `<public-ip>:53551:53551`.

### SEC-2026-06-02-111 — Grafana defaults to admin/demos and `localhost` root URL

Severity: high
CWE: CWE-798 (Use of Hard-coded Credentials), CWE-1188 (Insecure Default)
File: `docker-compose.yml:268-271`, `.env.example:262-263`

`GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER:-admin}` /
`GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-demos}` boots
Grafana with `admin/demos` whenever `.env` omits the override.
Grafana port `3000` is published to the host
(`docker-compose.yml:305`) by default whenever the `monitoring`
profile is active — which **is the default** per
`.env.example:253` (`COMPOSE_PROFILES=monitoring,tlsnotary`).

The `.env.example:15` comment "default 'demos' is fine for solo, not
for shared" is not enforced anywhere — operators who never read the
comment ship the default into production.

Cross-ref: same risk class as `SEC-2026-06-02-106`. Both are folded
into the startup-gate recommendation in `02-secrets-in-tree.md`.

Remediation: in addition to the startup gate, set
`GRAFANA_ADMIN_PASSWORD=` (empty) in `.env.example` so the operator is
forced to fill it in (and let `docker-compose.yml` refuse to boot when
empty + `PROD=true`).

### SEC-2026-06-02-112 — Neo4j defaults to `neo4j/changeme-please` and ports published

Severity: medium
CWE: CWE-798, CWE-1188
File: `docker-compose.yml:354-362`

`NEO4J_AUTH: ${NEO4J_AUTH:-neo4j/changeme-please}` plus
`"${NEO4J_HTTP_PORT:-7474}:7474"` / `"${NEO4J_BOLT_PORT:-7687}:7687"`.
The `neo4j` profile is opt-in (not in the default
`COMPOSE_PROFILES`), so this only bites operators who enable
CGC/KYC features, but they get a Bolt-protocol DB with a publicly-known
default credential bound to `0.0.0.0`.

Same remediation as `SEC-2026-06-02-111`: empty default + boot gate.
Additionally, document that bolt-protocol auth is sent in cleartext
unless TLS is configured — Caddy does not front 7687.

### SEC-2026-06-02-113 — Prometheus port published with `--web.enable-lifecycle`

Severity: medium
CWE: CWE-862 (Missing Authorization)
File: `docker-compose.yml:215-225`, `docker-compose.yml:240-241`

Prometheus is launched with `--web.enable-lifecycle`
(`docker-compose.yml:225`), which enables unauthenticated
`POST /-/reload` and `POST /-/quit` endpoints. Host port `9091:9090`
is published by default whenever the `monitoring` profile is on
(default per `.env.example:253`).

A reachable attacker can `curl -XPOST http://<host>:9091/-/quit` to
kill the metrics pipeline, or `POST /-/reload` to force config
reloads. Prometheus has **no built-in authentication** — the upstream
docs explicitly say "use a reverse proxy".

The Caddyfile does proxy `/prometheus/*` behind the `proxy` profile
(`monitoring/caddy/Caddyfile:113-115`) but **does NOT add basic-auth on
that route** (only `/metrics` and `/mcp` get basic-auth). And the host
port publish at `9091` bypasses Caddy entirely.

Remediation:
1. Drop `--web.enable-lifecycle` unless explicitly needed.
2. Switch the host publish to `127.0.0.1:9091:9090` so it's
   loopback-only.
3. Add `basic_auth` to the `handle_path /prometheus/*` block in the
   Caddyfile with its own env-driven hash.

### SEC-2026-06-02-114 — `node-exporter` mounts host root `/` as `/rootfs:ro`

Severity: medium
CWE: CWE-552 (Files or Directories Accessible to External Parties),
CWE-200 (Exposure of Sensitive Information)
File: `docker-compose.yml:320-343`, `docker-compose.yml:332-333`

When `full` profile is on, node-exporter mounts the **entire host
filesystem** read-only at `/rootfs`. Combined with port `9100`
published `0.0.0.0` (`docker-compose.yml:334-335`), an unauthenticated
attacker who can reach the metrics endpoint can read host filesystem
metadata (mount points, filesystem types, free space, inode counts,
device mappings) — and through `--collector.filesystem` they get
per-mount detail. The `mount-points-exclude` regex only filters from
metrics, not from the bind mount itself.

Remediation: publish on `127.0.0.1:9100:9100` only; document the
`monitoring` Prometheus scrapes this over the docker bridge. Add basic-auth
when reverse-proxied. Consider dropping `:/rootfs:ro` and relying on
`/proc` + `/sys` only.

### SEC-2026-06-02-115 — Caddy basic-auth fallback hashes are sentinel-invalid (good), but never warned about

Severity: informational
CWE: CWE-1188
File: `docker-compose.yml:407-408`, `monitoring/caddy/Caddyfile:84-95`

The `METRICS_BASIC_AUTH_HASH` / `MCP_BASIC_AUTH_HASH` fallbacks are
intentional sentinels (`$$2a$$14$$invalidinvalid…`) that reject every
password. That's correct behaviour. But the operator gets **no startup
log message** indicating they're running with the sentinel — they see
a "401 Unauthorized" the first time they try `/metrics` and can spend
time debugging credentials before realising the route is fail-closed.

Remediation: add a Caddyfile `log` directive that emits a warning
when the placeholder hash is in use, or document the symptom in
`docs/runbooks/proxy-setup.md`. Low risk; better DX.

### SEC-2026-06-02-116 — Caddy admin port `2019` reachable from any container on `demos-network`

Severity: medium
CWE: CWE-668 (Exposure of Resource to Wrong Sphere)
File: `monitoring/caddy/Caddyfile:33`

`admin localhost:2019` binds the Caddy admin API to **`localhost`
inside the Caddy container**, which is the loopback interface of that
container only. So far so good — but the same address is what the
healthcheck probes (`docker-compose.yml:426`), and the comment
correctly notes "the docker bridge alone is not a security boundary"
(`monitoring/caddy/Caddyfile:32`).

The risk is small in practice: an attacker would need code execution
inside the Caddy container to hit `localhost:2019`. But Caddy's admin
API is by default **unauthenticated** and can rewrite the entire
config, including TLS termination — RCE in any docker bridge container
that can lateral-move into Caddy results in cert+route hijack.

Remediation: keep `admin localhost:2019` (correct). Add `admin off`
in production deployments where dynamic config reload is not needed,
or configure
[mTLS for admin](https://caddyserver.com/docs/caddyfile/options#admin)
.

### SEC-2026-06-02-117 — `request_header -X-Forwarded-*` strip is single-vhost only

Severity: low
CWE: CWE-348 (Use of Less Trusted Source)
File: `monitoring/caddy/Caddyfile:56-59`

The strip of inbound `X-Forwarded-*` only lives inside the
`{$PROXY_DOMAIN}` vhost. The optional `notary.${PROXY_DOMAIN}` vhost
(imported from `tlsnotary-modes/subdomain-vhost.caddy` when the mode
is `subdomain`) does **not** strip. An attacker hitting the notary
subdomain with spoofed `X-Forwarded-For` can manipulate the upstream
rate-limiter's source-IP attribution.

Remediation: move the strip into the global `(security_headers)`
snippet and `import` it from every vhost.

### SEC-2026-06-02-118 — Caddy access log to stdout includes full URI (potential PII)

Severity: informational
CWE: CWE-532 (Insertion of Sensitive Information into Log File)
File: `monitoring/caddy/Caddyfile:126-129`

JSON access log captures full request URIs. Several RPC routes accept
parameters in the query string or path (e.g.
`/storage-program/owner/:owner`, identity-bearing headers
forwarded into RPC). When these logs ship to a third-party aggregator
they may carry public-address-level PII / linkable identity material.

Cross-ref: `04-authentication-and-authorization.md` covers the route
shape. This file flags the **logging-side** angle.

Remediation: configure the Caddy log block with a
`format json { request_uri "[REDACTED]" }` override for routes that
embed identity-bearing path params, or aggregate at sanitised host
level only.

---

## Compose — `docker-compose.proxy.yml`

### SEC-2026-06-02-119 — Override drops every port but does not switch binds to loopback

Severity: low (defence-in-depth)
CWE: CWE-668
File: `docker-compose.proxy.yml:32-53`

The proxy override uses `ports: !override` to drop host publishes for
prometheus / grafana / node-exporter / neo4j / tlsnotary. That correctly
hides them from the host's external interfaces — but the underlying
services still bind `0.0.0.0` inside their containers. Any future
ad-hoc `docker compose --no-deps run` that publishes a port will
expose them again.

Remediation: explicit `ports: !override` everywhere is fine; pair with
docs noting "to expose <service>, override binds to specific
addresses, never re-add a bare `9090:9090`."

---

## Monitoring stand-alone compose — `monitoring/docker-compose.yml`

This file appears to predate the unified compose in the repo root and
duplicates Prometheus + Grafana + node-exporter with the SAME default
credentials. If both files are run on the same host, container-name
collision (`demos-prometheus`, `demos-grafana`) will block one of
them — but the security defaults are identical and the issues already
filed under `SEC-2026-06-02-111` / `-113` / `-114` apply verbatim.

### SEC-2026-06-02-120 — Duplicated compose file with same default creds and no profile gating

Severity: low
CWE: CWE-1059 (Insufficient Technical Documentation), CWE-1188
File: `monitoring/docker-compose.yml`

Standalone monitoring stack lacks the profile gating the root
compose introduced. Operators running both files double their exposed
surface and may run a second `demos-grafana` with `admin/demos` on the
same host.

Remediation: either delete `monitoring/docker-compose.yml` (the root
compose subsumes it), or add a top-of-file comment marking it
deprecated and pointing at the unified compose.

---

## TLSNotary stand-alone compose — `tlsnotary/docker-compose.yml`

### SEC-2026-06-02-121 — TLSNotary uses upstream image's internal signing key with no documented rotation

Severity: medium
CWE: CWE-321 (Use of Hard-coded Cryptographic Key)
File: `tlsnotary/docker-compose.yml:28-30`,
`docker-compose.yml:157` (`TLSNOTARY_SIGNING_KEY` passthrough)

The comment notes "The Docker notary-server uses its own internal
signing key. Attestations are cryptographically bound to this notary's
public key." There is **no operational guidance** for:

- Rotating the internal key (rebuild image? mount external key?).
- Persisting the key across container recreation (no volume mount,
  so `docker compose down` likely regenerates and invalidates all
  previously issued attestations).
- Detecting key drift between primary and standby deployments.

Combined with `TLSNOTARY_FATAL=false` (`.env.example:211`) which lets
the node soft-fail when notary calls don't return, an attacker who
restarts the notary mid-flow can silently invalidate attestations the
node already considered final.

Remediation: document key persistence (mount `/etc/notary` as a named
volume), document rotation procedure, and add a startup health probe
that warns when the notary's public key changes between boots.

### SEC-2026-06-02-122 — TLSNotary stand-alone compose healthcheck uses `curl` but image lacks it

Severity: low (correctness bug, not a vuln)
CWE: CWE-754 (Improper Check for Unusual or Exceptional Conditions)
File: `tlsnotary/docker-compose.yml:23`

`test: [CMD, curl, -f, http://localhost:7047/info]` — the upstream
image **does not ship curl** (this is the exact problem the root
compose works around with `bash /dev/tcp` at
`docker-compose.yml:83`). The standalone compose's healthcheck
therefore always fails, the container stays "unhealthy", and any
operator relying on this file gets a misleading status.

Remediation: align with the root compose's bash `/dev/tcp` probe.

---

## Postgres stand-alone compose — `postgres/docker-compose.yml`

### SEC-2026-06-02-123 — Hard-coded `demosuser` / `demospassword` literals, no env override

Severity: high
CWE: CWE-798 (Use of Hard-coded Credentials)
File: `postgres/docker-compose.yml:6-9`

Unlike the root compose which uses `${PG_USER:-demosuser}`, this
standalone file hard-codes:

```
POSTGRES_USER: demosuser
POSTGRES_PASSWORD: demospassword
POSTGRES_DB: demos
```

There is **no** environment substitution. An operator who follows the
README path and starts `postgres/docker-compose.yml` directly cannot
override the credential without editing the file. Combined with
`"${PG_PORT}:5432"` (line 13) which **requires** `PG_PORT` to be set
in env and publishes to `0.0.0.0`, this is the worst-case path: known
default credentials reachable on the host network.

Remediation: switch to `${PG_USER:-demosuser}` /
`${PG_PASSWORD:?must be set}` (the `:?` form errors if unset, refusing
to boot). Bind publish to `127.0.0.1:${PG_PORT}:5432`. Add a top-of-file
comment marking the file deprecated in favour of the unified compose.

### SEC-2026-06-02-124 — Postgres image used without tag (`image: postgres`)

Severity: medium
CWE: CWE-829, CWE-1357
File: `postgres/docker-compose.yml:4`

`image: postgres` resolves to `postgres:latest` — a moving target.
Major-version upgrades will eat the data directory format. Operators
get either silent corruption (best case: refusal to start) or, on a
fresh `down -v && up`, a completely new chain DB with no migration
trail.

Remediation: pin to `postgres:16-alpine` to match the root compose.

---

## Entrypoint — `scripts/docker-entrypoint.sh`

### SEC-2026-06-02-125 — Entrypoint uses `/bin/sh` (`set -eu`) without `-o pipefail`

Severity: informational
CWE: CWE-754
File: `scripts/docker-entrypoint.sh:1`, `scripts/docker-entrypoint.sh:17`

`set -eu` does not catch failures inside pipelines; this script does
not pipe, so the immediate risk is zero. But the script does
`mv "$link" "$target"` (`scripts/docker-entrypoint.sh:32`) without a
defensive copy-then-move pattern — a SIGKILL mid-`mv` on a non-atomic
filesystem will lose `.demos_identity` (and therefore the validator
key) with no backup. This is theoretical for ext4 (rename is atomic)
but real for some volume drivers that don't honour POSIX rename
semantics.

Remediation: low priority. Consider `cp -a "$link" "$target.tmp" &&
mv "$target.tmp" "$target" && rm "$link"`, and add `set -o pipefail`
prophylactically in case future edits add pipes.

### SEC-2026-06-02-126 — No symlink-attack guard on `/app/.demos_identity` etc.

Severity: low
CWE: CWE-59 (Improper Link Resolution Before File Access — Link Following)
File: `scripts/docker-entrypoint.sh:30-39`

The script does `if [ -e "$link" ] && [ ! -L "$link" ] ; then mv …`.
If an attacker can place a symlink at `/app/.demos_identity` pointing
elsewhere on the filesystem **before** the entrypoint runs, the
`! -L` branch is skipped and the `[ -L "$link" ] || ln -s …` branch
trusts whatever the symlink points to. Reachability requires write
access to `/app` before entrypoint runs, which under the COPY
ownership scheme (`root:demos`, mode `0755` —
`Dockerfile:175-179`) means root or demos compromise — already
game-over.

Remediation: cheap belt-and-braces — `readlink -f` the link target
and refuse to use it if it escapes `$STATE_DIR`.

---

## Caddyfile — `monitoring/caddy/Caddyfile`

### SEC-2026-06-02-127 — Caddyfile does not gate `/grafana/*` behind extra auth

Severity: medium
CWE: CWE-306 (Missing Authentication for Critical Function)
File: `monitoring/caddy/Caddyfile:103-105`

Grafana has its own authentication, but it ships with the default
`admin/demos` credential (`SEC-2026-06-02-111`). The Caddyfile
forwards `/grafana/*` unauthenticated, so the only thing between the
internet and the Grafana login form is a default password until the
operator changes it. The runbook recommends adding 2FA but the
Caddyfile itself adds no defence-in-depth layer.

Remediation: optionally wrap `/grafana/*` in `basic_auth` with a
`GRAFANA_PROXY_BASIC_AUTH_HASH` env, OR gate behind IP allow-list
(`@trusted not remote_ip ...`). Document the trade-off.

### SEC-2026-06-02-128 — Healthcheck on `:80` redirected to HTTPS — `wget --spider` may fail on self-signed

Severity: informational
File: `monitoring/caddy/Caddyfile:43-45`, `docker-compose.yml:426`

The healthcheck was already fixed (Greptile P2 comment) to probe
`http://localhost:2019/config/` instead of `:80`, which is correct
for a containerised loopback. Cross-noting here for completeness —
no action needed.

### SEC-2026-06-02-129 — `request_header -X-Real-IP` strip is on, but `Cf-Connecting-IP`/`True-Client-IP` are not

Severity: low
CWE: CWE-348
File: `monitoring/caddy/Caddyfile:56-59`

The strip-list is `X-Forwarded-For`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `X-Real-IP`. Multi-hop Cloudflare or Akamai
deployments use `CF-Connecting-IP` / `True-Client-IP` / `Fastly-Client-IP`
etc. If the operator puts Caddy behind a CDN and the node honours one
of those headers downstream, the strip-list is incomplete.

Cross-ref: `src/libs/network/routines/getRemoteIP.ts` — the node's
trusted-proxy logic determines which headers it honours. Audit that
list against the Caddy strip-list.

Remediation: expand the strip-list. Confirm
`getRemoteIP.ts` only honours `X-Forwarded-For` (Epic 14 T1) and
nothing else.

---

## Findings index

| ID | Severity | Topic |
|---|---|---|
| SEC-2026-06-02-100 | low | Base image tag not digest-pinned |
| SEC-2026-06-02-101 | medium | `bun pm trust --all` runs all postinstalls |
| SEC-2026-06-02-102 | low | `falcon-sign` patched in-image without integrity check |
| SEC-2026-06-02-103 | informational | `curl` in runtime image only for healthcheck |
| SEC-2026-06-02-104 | low | No `STOPSIGNAL` / init shim |
| SEC-2026-06-02-105 | informational | Build-time `GIT_*` ARGs leak as ENV |
| SEC-2026-06-02-106 | high | Postgres password defaults to `demospassword` |
| SEC-2026-06-02-107 | medium | Credentials passed via `environment:` not `secrets:` |
| SEC-2026-06-02-108 | high | Metrics bind `0.0.0.0` AND host-published by default |
| SEC-2026-06-02-109 | medium | RPC port published `0.0.0.0` even in proxy mode |
| SEC-2026-06-02-110 | medium | OmniProtocol published `0.0.0.0` in proxy mode |
| SEC-2026-06-02-111 | high | Grafana defaults to `admin/demos`, port published |
| SEC-2026-06-02-112 | medium | Neo4j defaults to `neo4j/changeme-please`, ports published |
| SEC-2026-06-02-113 | medium | Prometheus `--web.enable-lifecycle` + unauth host port |
| SEC-2026-06-02-114 | medium | node-exporter mounts `/` as `/rootfs:ro`, port 9100 public |
| SEC-2026-06-02-115 | informational | Caddy basic-auth sentinel never logged |
| SEC-2026-06-02-116 | medium | Caddy admin API reachable from same container |
| SEC-2026-06-02-117 | low | `X-Forwarded-*` strip lives in single vhost only |
| SEC-2026-06-02-118 | informational | Caddy access log captures URI-embedded identity |
| SEC-2026-06-02-119 | low | Proxy override drops ports but binds remain `0.0.0.0` |
| SEC-2026-06-02-120 | low | Duplicated monitoring compose with same defaults |
| SEC-2026-06-02-121 | medium | TLSNotary signing key not persisted / rotated |
| SEC-2026-06-02-122 | low | TLSNotary stand-alone healthcheck uses missing `curl` |
| SEC-2026-06-02-123 | high | Postgres stand-alone compose hard-codes credentials |
| SEC-2026-06-02-124 | medium | Postgres stand-alone uses unpinned `postgres:latest` |
| SEC-2026-06-02-125 | informational | Entrypoint lacks `pipefail`, non-atomic mv |
| SEC-2026-06-02-126 | low | Entrypoint trusts pre-existing symlinks |
| SEC-2026-06-02-127 | medium | Caddy `/grafana/*` has no extra auth layer |
| SEC-2026-06-02-128 | informational | Healthcheck note (already fixed) |
| SEC-2026-06-02-129 | low | `X-Forwarded-*` strip-list incomplete (CDN headers) |

Severity totals (S10 only):
- high: 4
- medium: 11
- low: 9
- informational: 6
- critical: 0

Total findings filed: 30.

---

## Cross-cutting recommendations (not findings — owner: release-engineering)

1. **Single startup gate** that refuses to boot when `PROD=true` and
   any of `PG_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, `NEO4J_AUTH`,
   `MCP_BASIC_AUTH_HASH`, `METRICS_BASIC_AUTH_HASH` match their
   documented defaults or are empty. Implement in `src/config/` —
   covered jointly by findings `-106`, `-107`, `-111`, `-112`.

2. **Bind everything to loopback in proxy mode.** Add a
   `proxy-bindings.yml` override that switches every container's host
   publish to `127.0.0.1:...:...`. Covers `-108`, `-109`, `-110`,
   `-113`, `-114`, `-119`.

3. **Digest-pin every image** in one PR. Covers `-100`, `-124`.

4. **Use compose `secrets:` for everything sensitive.** One refactor.
   Covers `-107` and reduces blast radius of `-106`, `-111`, `-112`,
   `-121`.

5. **Delete `monitoring/docker-compose.yml` and `postgres/docker-compose.yml`
   or label them deprecated** — they predate the unified compose and
   carry the same vulns with weaker overrides. Covers `-120`, `-123`,
   `-124`.

6. **Cross-reference the runbook**: `docs/runbooks/proxy-setup.md`
   should document the loopback-bind pattern, the startup gate, and
   the basic-auth sentinel warning so operators don't get caught by
   `-115`, `-119`.
