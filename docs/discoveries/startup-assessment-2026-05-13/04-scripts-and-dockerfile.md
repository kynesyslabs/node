---
type: discovery-slice
title: Dockerfile, Run Scripts and Build Pipeline
date: 2026-05-13
---

# Dockerfile, Run Scripts and Build Pipeline

## Dockerfile (8.8K, 2 stages)

### Stage 1 `builder` (`oven/bun:1.3-debian`)
- Build deps: `build-essential python3 python3-setuptools ca-certificates` (for node-gyp / native modules: `bufferutil`, `utf-8-validate`)
- `bun install --frozen-lockfile` → `bun pm trust --all || true` (split intentionally; trust failure tolerated, install failure not)
- Explicit `bun add bufferutil utf-8-validate` (lockfile treats them optional)
- COPY allow-list: `src/ scripts/ data/ sdk/ libs/ tsconfig.json bunfig.toml ormconfig.json` (no `COPY . .`)
- **falcon-sign patch:** `sed -i` injects `console.error(ex)` before `throw ex` in `falcon512.js`. Idempotent.
- **Prune pass** (ARG `PRUNE_MODULES=true`): deletes READMEs/CHANGELOGs/LICENSEs/`.map`/`__tests__`/`__mocks__`/`example(s)`/`docs`. Saves ~200-400 MB. Explicit note: bare `test/`/`tests/` NOT pruned (viem ships prod code there).

### Stage 2 `runtime` (`oven/bun:1.3-debian`)
- Runtime deps: `curl ca-certificates` only
- User rename: `groupmod/usermod bun → demos` (preserves uid/gid 1000 for bind-mount sanity)
- `COPY --from=builder --chown=root:demos /app /app` (defense-in-depth: app tree owned root, demos cannot rewrite code)
- demos writes only on `/app/data /app/logs /app/state`
- ENV: `NODE_ENV=production RPC_PORT=53550 METRICS_HOST=0.0.0.0`
- **EXPOSE:** 53550 (RPC), 53551 (omni), 3005 (WebRTC sig), 3001 (MCP), 9090 (metrics). 7047 (TLSNotary) deliberately NOT exposed (separate container).
- VOLUME: `/app/data /app/logs /app/state`
- USER `demos`
- **HEALTHCHECK:** `curl -fsS http://localhost:${RPC_PORT}/` — 30s interval, 5s timeout, 60s start-period, 3 retries (Dockerfile only; compose has no healthcheck on `node`).
- ENTRYPOINT: `/app/scripts/docker-entrypoint.sh`
- CMD: `bun -r tsconfig-paths/register src/index.ts -- --no-tui`

## .dockerignore

Blocks `.git`, AI tooling (`.claude .beads .serena .taskmaster .mcp_data`), secrets (`.tlsnotary-key *.key *.pem .env*`), runtime state (`.demos_identity demos_peerlist.json data/chain.db* logs/ output/ postgres_*`), test dirs (`tests/ testing/ local_tests/`), docs (`*.md`), compose files (`docker-compose*.yml`).

Carve-outs: keeps `testing/devnet/run-devnet`, `testing/devnet/start-staggered.sh`, `testing/devnet/scripts/`. **sdk/ deliberately not excluded** (src/ imports from `sdk/localsdk/...`).

## Scripts

| File | Purpose | Invokes | Side effects |
|---|---|---|---|
| `run` (root, 163B) | Thin wrapper → forwards to `scripts/run` | `exec scripts/run "$@"` | None |
| `.RUN` | Empty sentinel — presence means first-run done | — | `touch`ed by `scripts/run` after first bun install |
| `scripts/run` (30.6K) | Bare-metal launcher | `bun install`, `git pull`, `docker compose up -d` (postgres/tlsnotary/monitoring), `bun start:bun` | Edits git remotes, stashes, sed-patches falcon-sign, copies `postgres → postgres_<port>`, writes `last_crash_memory_usage.txt` |
| `scripts/docker-entrypoint.sh` (2.3K) | Container entrypoint — bridges writable files to `/app/state` volume via symlinks, then `exec "$@"` | `mkdir`, `mv`, `ln -s` | Creates symlinks for `.demos_identity .demos_peerlist.json .tlsnotary-key output/`; **publickey_* NOT persisted** (regenerable) |
| `scripts/start_db` (6.9K) | Standalone PG starter for DB inspection | `docker compose up -d` in `postgres_<port>` | Copies `postgres → postgres_<port>`, infinite `while true; sleep 1` keepalive |
| `scripts/install-deps.sh` (581B) | Bare-metal dep bootstrap | `bun install`, `bun pm trust --all`, `cargo install wstcp` | Adds `~/.cargo/bin` to PATH; idempotent on wstcp |
| `scripts/reset-node` (5.9K) | Nuclear reinstall preserving identity+peerlist | `rm -rf <node_dir>`, `git clone`, `bun install` | Destroys CWD, backs up identity/peerlist to parent dir |
| `captraf.sh` (927B) | Debug: tcpdump HTTP on a port → pcap → JSON | `sudo tcpdump`, `tshark`, `jq` | Writes `http-capture-<ts>.pcap` + `.json`; needs sudo |

## Signal Handling

- **Container:** ENTRYPOINT `sh` script ends with `exec "$@"` → bun receives PID 1, gets SIGTERM directly from docker. Whether bun→node app does graceful shutdown is **app-level** (not in scripts). No `tini`/`dumb-init`. Sub-children of bun (e.g. native libs) may orphan on `docker stop`.
- **bunfig.toml:** only `install.exact = true`. No runtime tuning.
- **scripts/run:** `trap ctrl_c INT` — on Ctrl-C, `docker compose down` for postgres_<port>, tlsnotary, monitoring. **Does NOT trap TERM;** `kill <pid>` won't trigger cleanup. After node exit, repeats teardown (force `docker kill` fallback for TLSN).
- **scripts/start_db:** traps INT only.
- **captraf.sh:** traps INT+TERM, post-processes pcap.

## Build vs Runtime Gap

- Build has `python3 build-essential` — correctly dropped at runtime (native modules already compiled).
- Build runs `bun pm trust --all` — postinstall artifacts baked in, fine at runtime.
- **No `tini`/`dumb-init`** in runtime image despite bun-as-PID-1 — zombie reaping relies on bun's own behavior.
- **`netcat` (`nc`) not in runtime image** but `scripts/run` uses `nc -z` for DB ready checks. Irrelevant inside container (entrypoint doesn't call `scripts/run`), but if someone shells in and runs it, fails.
- **`wstcp` from install-deps.sh not in image.** If the node code paths through WebSocket-over-TCP proxy use it, container is broken — confirm.
- `git`, `lsof`, `netstat` absent at runtime — fine, entrypoint doesn't need them.

## Smells (12 concrete items)

1. **`start_db` corruption:** lines 110, 151, 155, 158, 163, 174, 218, 251 contain `${: $PG_P}ORT`, `${ $PG_PO}RT`, `${t $PG_P}ORT` — broken parameter expansions. Script likely runs (errors print garbled), but display strings are wrong. Was probably mangled by an editor. **Real bug.**
2. **`scripts/run` line 469:** `set -- "${@/--no-tui/}"` uses bash-only pattern substitution on positional params — creates empty string args (not removal) when arg is exactly `--no-tui`. `getopts` then sees an empty arg. Probably benign because `getopts` skips empties, but fragile.
3. **Swallowed exit codes:** `docker compose down 2>/dev/null || true` repeated 5+ times (run, ctrl_c). Real shutdown failures invisible. TLSN cleanup deliberately force-kills via `docker rm -f` — accepts data loss.
4. **`bun pm trust --all || true`** in both Dockerfile and `install-deps.sh` — comment in Dockerfile explains why; `install-deps.sh` is silent.
5. **`scripts/run` `cd $PG_FOLDER || exit`** with no exit code — bare `exit` returns last status, can be 0 on a `cd` failure that produced no prior status. Mildly broken.
6. **`scripts/run` line 648:** `START_COMMAND="bun start:bun"` overrides the just-computed `bun run start:bun`. Comment says `# Temporary overriding`. So the runtime selection block above (lines 614-647) is dead code.
7. **`git pull` inside `scripts/run`:** launcher mutates working tree. CI/airgapped operators must remember `-n` or set `GIT_PULL=false`.
8. **No TERM trap** anywhere in `scripts/run`. `systemctl stop demos-node` (if wrapped) won't cleanly bring down postgres/tlsn/monitoring sidecars.
9. **`reset-node`** does `rm -rf "${node_dir}"` after `cd "${parent_dir}"`. If `parent_dir` resolves wrong (e.g. symlinks), this is destructive. Identity backup goes to `parent_dir` — if user runs in `/`, backups go to `/`.
10. **Hardcoded ports:** `5332` (PG), `53550` (RPC), `7047` (TLSN), `3000` (Grafana), `9091` (Prom) scattered through `scripts/run` and Dockerfile. Multi-instance support via `postgres_<port>` folder copying is hacky.
11. **`captraf.sh`** needs `sudo`, `tshark`, `jq` — none documented as requirements.
12. **Healthcheck** is `curl /` not `/health` — depends on root path returning 2xx. If RPC root returns 4xx (auth-required), container marks unhealthy despite working node.
13. **`.RUN` sentinel** is brittle: if you `git pull` new dependencies, `scripts/run` skips the install (only runs install on first run OR when `GIT_PULL=true`). User running `./run -n` after fresh `bun.lock` change gets a stale install.

## Files (absolute paths)

- `/Users/tcsenpai/kynesys/node/Dockerfile`
- `/Users/tcsenpai/kynesys/node/.dockerignore`
- `/Users/tcsenpai/kynesys/node/run`
- `/Users/tcsenpai/kynesys/node/.RUN` (empty)
- `/Users/tcsenpai/kynesys/node/scripts/run`
- `/Users/tcsenpai/kynesys/node/scripts/docker-entrypoint.sh`
- `/Users/tcsenpai/kynesys/node/scripts/start_db` (has bash expansion corruption)
- `/Users/tcsenpai/kynesys/node/scripts/install-deps.sh`
- `/Users/tcsenpai/kynesys/node/scripts/reset-node`
- `/Users/tcsenpai/kynesys/node/captraf.sh`
- `/Users/tcsenpai/kynesys/node/bunfig.toml`
- `/Users/tcsenpai/kynesys/node/package.json`
