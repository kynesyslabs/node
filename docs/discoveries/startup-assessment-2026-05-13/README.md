---
type: discovery
title: Node Startup & Stack Flow Assessment
date: 2026-05-13
status: active
branch: better_startup
scope: read-only assessment, no changes
---

# Node Startup & Stack Flow Assessment

Read-only audit of the Demos Network node startup, container topology, port surface, and fragility. Triggered by operator complaints:

1. **Hard to debug what started and what didn't.**
2. **Too many open ports / certificates on remote servers.**
3. **Stack feels fragile.**

This folder contains the raw assessment in four parallel slices plus a synthesis.

## Files

| File | Topic |
|------|-------|
| [`01-compose-services.md`](./01-compose-services.md) | Every docker-compose service: image, ports, env, deps, healthchecks |
| [`02-startup-trace.md`](./02-startup-trace.md) | 20-step boot sequence with blocking/failure/log per step |
| [`03-ports-and-certs.md`](./03-ports-and-certs.md) | Complete port inventory + TLS cert touchpoints |
| [`04-scripts-and-dockerfile.md`](./04-scripts-and-dockerfile.md) | Dockerfile stages + every run/build script with smells |
| [`05-fragility-synthesis.md`](./05-fragility-synthesis.md) | **Read this first.** Cross-cut findings + ranked risks |

## TL;DR

- **20 bootstrap steps**, of which **3 succeed silently** and **~6 are background or async-bind without verified status**.
- **Default profile exposes 7 host ports**; full set with all profiles **= 11**, plus an ephemeral pool of **up to 2000 wstcp ports**.
- **Only 1 of those ports uses real X.509 TLS today** (OmniProtocol 53551, conditional). Operator perception that "many certs are needed" is mostly false — but most public endpoints **are cleartext and probably shouldn't be exposed at all**.
- **One dormant-but-looks-alive failure mode**: `enough_peers=false` silently skips the entire consensus half of boot (Signaling, MCP, TLSN, mainLoop, DTR, L2PS) — RPC and metrics keep answering, node looks healthy. This is the single highest-impact source of "what's wrong" confusion.
- **Top three concrete actions** if/when remediation begins (see synthesis for full ranking):
  1. Add explicit start/ready/fail markers + dormant-state warning around the `enough_peers` gate (`src/index.ts:589-884`).
  2. Reverse-proxy the 6 HTTP/WS host ports behind a single 443 endpoint to collapse the cert surface.
  3. Add a real container healthcheck for `node` (currently has none in compose).
