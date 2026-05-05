# SDK Capability Detection — Implementation Plan

> ## ⚠️ Repo scope
>
> **This document plans work in `kynesyslabs/sdks`.** It lives in `kynesyslabs/node` only as a planning artifact (we use `node/docs/planning/` as the durable home for cross-cutting plans).
>
> - **Implementation target:** `kynesyslabs/sdks` — branch `claude/checkout-branches-WQCIg`.
> - **Node-side prerequisites:** already shipped on `kynesyslabs/node` `claude/checkout-branches-WQCIg`. **Do NOT modify `kynesyslabs/node` while implementing item 9.**
> - **Throughout this doc, every code path is prefixed `sdks/...` or `node/...`** so there is zero ambiguity about which repo to open.

---

## 1. Goal

When a Demos SDK method calls a node RPC that the connected node doesn't support, the SDK currently returns `null` or garbage. The caller cannot distinguish "method not supported" from "called and got empty result". This work surfaces the distinction with a typed error, gated behind an opt-in flag with a deprecation path for the legacy `null` behavior.

## 2. Context — what's already shipped (do NOT redo)

### 2.1 Already on `kynesyslabs/node` (do NOT modify these — read-only context)

| Phase / Item | Commit (relative to base) | What it gives us |
|---|---|---|
| Phase 1, item 1 | `node:e57be21` | Unknown RPC messages → `result: 404` + JSON `{error: "Unknown message", message: "<wireName>"}`. **This is what the SDK reactively detects.** |
| Phase 1, item 5 | `node:564f0af` | `GET /health` → `{version, version_name, accepting, mempool_size, uptime_s}`. **Used for proactive version gating.** |
| Phase 2, item 7 | `node:2b97270` | 9 storage-program read RPCs implemented. These are the methods that need a min-version on the SDK side. |

### 2.2 Already on `kynesyslabs/sdks` (read-only context — you'll *extend* these, not replace them)

| Phase / Item | What it gives us |
|---|---|
| Phase 1, item 6 | Unified `_doPost(url, body, headers, opts)` private method on `Demos` (`sdks/src/websdk/demosclass.ts:676`) with retry-on-5xx and `Retry-After` support. `TransportError` exported. **This is the choke point where reactive 404 detection plugs in.** |
| Phase 1, item 8 | `DemosTransactions.broadcastAndWait` + `BroadcastTimeoutError`. |

You should **not** re-investigate these. Read them if useful, but they're done.

## 3. Architectural decisions (already made — do not relitigate)

| Decision | Choice | Rationale |
|---|---|---|
| Detection style | **Both reactive (transport-level) AND proactive (per-method)** | Reactive catches everything via `Demos.call`; proactive (decorator) gives early failure without a roundtrip. |
| Local gating mechanism | **TS legacy decorators** (`experimentalDecorators: true`) | Mature, well-supported on TS 5.9. Stage-3 is settling but ecosystem still patchy. Static methods need decorator support which legacy has. |
| Non-class-method gating | **Manual `assertNodeVersion(demos, "X.Y.Z", "wireName")` helper** | `DemosTransactions` is an object literal — decorators don't apply. Same for arrow-fn class fields. |
| Default behavior | **Opt-in `strictCapabilities` flag** (default `false`) | Preserves back-compat. |
| Legacy path behavior | **`console.warn` deprecation notice + return null** (current behavior) | Tells users the migration is coming; doesn't break them today. |
| Strict path behavior | **Throw `MethodNotSupportedError`** | Typed, explicit. |
| Error class hierarchy | **No hierarchy** — `MethodNotSupportedError` is standalone, sibling to `TransportError` and `BroadcastTimeoutError` | Consistent with prior phases. |
| Deprecation warning dedup | **One warn per `(rpcUrl, wireName)` tuple** | Avoid spamming in polling loops. |
| Decorator metadata | **`emitDecoratorMetadata: false`** initially (try without first) | Only enable if a decorator actually needs it. We probably won't. |

## 4. SDK audit (verbatim findings — `sdks/...` paths authoritative)

The audit ran `grep`/Explore over `sdks/src/`. ~30 public methods hit the node across 7 files. **Source of truth for wire names is the SDK itself** (not the node, not docs).

### 4.1 Decoratable methods (class methods, native `this.rpc_url` or constructor-injected)

#### `sdks/src/websdk/demosclass.ts` — `Demos` class

| Method | Line | Wire | Returns |
|---|---|---|---|
| `getLastBlockNumber()` | 931 | `getLastBlockNumber` | `Promise<number>` |
| `getLastBlockHash()` | 938 | `getLastBlockHash` | `Promise<string \| null>` |
| `getBlocks(start, limit)` | 946 | `getBlocks` | `Promise<Block[]>` |
| `getBlockByNumber(n)` | 958 | `getBlockByNumber` | `Promise<Block>` |
| `getBlockByHash(h)` | 969 | `getBlockByHash` | `Promise<Block>` |
| `getTxByHash(h)` | 980 | `getTxByHash` | `Promise<Transaction>` |
| `getAllTxs()` | 995 | (delegates to `getTransactions`) | — |
| `getTransactionHistory(addr, type, opts)` | 1009 | `getTransactionHistory` | `Promise<Transaction[]>` |
| `getTransactions(start, limit)` | 1024 | `getTransactions` | `Promise<RawTransaction[]>` |
| `getPeerlist()` | 1034 | `getPeerlist` | `Promise<IPeer[]>` |
| `getMempool()` | 1042 | `getMempool` | `Promise<Transaction[]>` |
| `getPeerIdentity()` | 1049 | `getPeerIdentity` | `Promise<string>` |
| `getAddressInfo(addr)` | 1058 | `getAddressInfo` | `Promise<AddressInfo \| null>` |
| `getAddressNonce(addr)` | 1082 | `getAddressNonce` | `Promise<number>` |

#### `sdks/src/storage/StorageProgram.ts` — `StorageProgram` static methods

| Method | Line | Wire | Returns |
|---|---|---|---|
| `getByAddress(rpc, addr, identity?)` | 809 | `getStorageProgram` | `StorageProgramData \| null` |
| `getByOwner(rpc, owner, identity?)` | 851 | `getStorageProgramsByOwner` | `StorageProgramListItem[]` |
| `searchByName(rpc, q, opts?)` | 904 | `searchStoragePrograms` | `StorageProgramListItem[]` |
| `getFields(rpc, addr, identity?)` | 961 | `getStorageProgramFields` | `… \| null` |
| `getValue(rpc, addr, field, identity?)` | 1004 | `getStorageProgramValue` | `… \| null` |
| `getItem(rpc, addr, field, idx, identity?)` | 1056 | `getStorageProgramItem` | `… \| null` |
| `hasField(rpc, addr, field, identity?)` | 1101 | `hasStorageProgramField` | `… \| null` |
| `getFieldType(rpc, addr, field, identity?)` | 1145 | `getStorageProgramFieldType` | `… \| null` |
| `getAll(rpc, addr, identity?)` | 1187 | `getStorageProgram` (alias) | `StorageProgramData \| null` |

> **Caveat:** `StorageProgram` methods are **static** and take `rpcUrl` as first arg. Each call may target a different node. The version cache must be a static `Map<rpcUrl, {version, fetchedAt}>`, not per-instance.

#### `sdks/src/contracts/ContractInteractor.ts`

| Method | Line | Wire | Returns |
|---|---|---|---|
| `viewCall<T>()` | 78 | `contractCall` | `ContractCallResult<T>` |
| `transactionCall<T>()` | 110 | `sendTransaction` | `ContractCallResult<T>` |
| `waitForTransaction()` | 232 | `getTransactionReceipt` | (polled) |

#### `sdks/src/websdk/Web2Calls.ts`

| Method | Line | Wire | Returns |
|---|---|---|---|
| `Web2Proxy.send(opts)` | 155 | `web2ProxyRequest` | `IWeb2Result` |

#### `sdks/src/abstraction/Identities.ts`

| Method | Line | Wire | Returns |
|---|---|---|---|
| `Identities.resolveUdDomain(demos, domain)` | 1070 | `resolveUdDomain` | (resolved domain info) |

### 4.2 NOT decoratable — needs `assertNodeVersion(...)` inline

| File | Symbol | Why |
|---|---|---|
| `sdks/src/websdk/DemosTransactions.ts` | `confirm` :186, `broadcast` :207, `broadcastAndWait` :264, plus `pay`, `transfer` | Whole module is an object literal, not a class |
| `sdks/src/websdk/demosclass.ts` `Demos.web2.getTweet` :1210 | arrow fn on object-literal property | Decorator targets methods, not arrow-fn properties |
| `sdks/src/websdk/demosclass.ts` `Demos.web2.getDiscordMessage` :1221 | same | same |
| `sdks/src/websdk/demosclass.ts` `Demos.ipfs.quote` :1261 | same | same |
| `sdks/src/websdk/Web2Calls.ts` `web2Calls.createDahr(demos)` :216 | exported arrow fn | free function, not a method |

### 4.3 TSConfig & build state (`kynesyslabs/sdks` only)

- `sdks/tsconfig.json`: `experimentalDecorators` **NOT set** (defaults `false`). Must flip to `true`.
- `emitDecoratorMetadata`: **NOT set**. Leave off unless needed. Verify after.
- `target`: `"es2020"` — fine.
- TypeScript: `5.9.2` — supports both legacy and stage-3.
- Build: `tsc --skipLibCheck && resolve-tspaths && mv build/src/* build/`. `resolve-tspaths` doesn't interact with decorators; should be fine.

## 5. Components to build (all in `kynesyslabs/sdks`)

### 5.1 `MethodNotSupportedError` — new file

**Path:** `sdks/src/websdk/MethodNotSupportedError.ts`

Match the style of `sdks/src/websdk/TransportError.ts` and `sdks/src/websdk/BroadcastTimeoutError.ts` (already in repo — read them first). No hierarchy, no `cause` chaining gymnastics.

```ts
export class MethodNotSupportedError extends Error {
    public readonly wireName: string
    public readonly requiredVersion: string
    public readonly actualVersion?: string
    public readonly rpcUrl?: string

    constructor(opts: {
        wireName: string
        requiredVersion: string
        actualVersion?: string
        rpcUrl?: string
    }) {
        const v = opts.actualVersion
            ? `node version ${opts.actualVersion}`
            : "the connected node"
        super(
            `Method "${opts.wireName}" is not supported by ${v} ` +
            `(requires >= ${opts.requiredVersion})`
        )
        this.name = "MethodNotSupportedError"
        this.wireName = opts.wireName
        this.requiredVersion = opts.requiredVersion
        this.actualVersion = opts.actualVersion
        this.rpcUrl = opts.rpcUrl
    }
}
```

Export from `sdks/src/websdk/index.ts`.

### 5.2 `capabilities.ts` — new file

**Path:** `sdks/src/websdk/capabilities.ts`

Holds: the decorator, the helper, the version cache, the deprecation warn dedup.

```ts
import { MethodNotSupportedError } from "./MethodNotSupportedError"

interface CachedHealth {
    version: string
    fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60_000        // 5 min
const HEALTH_FETCH_TIMEOUT_MS = 5_000

// Per-rpc-url version cache (used by static methods like StorageProgram).
const urlCache = new Map<string, CachedHealth>()
// Singleflight in-flight fetch per rpc url.
const inflight = new Map<string, Promise<string | null>>()
// Deprecation warn dedup: Set<`${rpcUrl}::${wireName}`>.
const warnedKeys = new Set<string>()

/**
 * Fetch /health and return the node version, or null if the node doesn't
 * support /health (pre-Phase-1) or fails. Cached per rpcUrl with TTL.
 */
export async function getNodeVersion(rpcUrl: string): Promise<string | null> {
    const cached = urlCache.get(rpcUrl)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.version
    }
    if (inflight.has(rpcUrl)) return inflight.get(rpcUrl)!

    const p = (async () => {
        try {
            const axios = (await import("axios")).default
            const res = await axios.get(`${rpcUrl.replace(/\/$/, "")}/health`, {
                timeout: HEALTH_FETCH_TIMEOUT_MS,
            })
            const version: string | undefined = res.data?.version
            if (typeof version === "string") {
                urlCache.set(rpcUrl, { version, fetchedAt: Date.now() })
                return version
            }
            return null
        } catch {
            return null
        } finally {
            inflight.delete(rpcUrl)
        }
    })()

    inflight.set(rpcUrl, p)
    return p
}

/** Compare semver strings (very small parser; "0.9.8" vs "0.9.9" etc.). */
export function semverGte(actual: string, required: string): boolean {
    const a = actual.split(/[.\-+]/).map(s => Number(s) || 0).slice(0, 3)
    const r = required.split(/[.\-+]/).map(s => Number(s) || 0).slice(0, 3)
    for (let i = 0; i < 3; i++) {
        const av = a[i] ?? 0
        const rv = r[i] ?? 0
        if (av > rv) return true
        if (av < rv) return false
    }
    return true
}

/**
 * Inline gate — call as the first await in any method that can't be decorated.
 * Pass the Demos instance so we can find rpcUrl + the strictCapabilities flag.
 */
export async function assertNodeVersion(
    demos: { rpc_url: string; strictCapabilities?: boolean },
    requiredVersion: string,
    wireName: string,
): Promise<void> {
    const actual = await getNodeVersion(demos.rpc_url)
    if (actual === null) {
        return softFailOrThrow(demos, requiredVersion, wireName, undefined)
    }
    if (semverGte(actual, requiredVersion)) return
    return softFailOrThrow(demos, requiredVersion, wireName, actual)
}

function softFailOrThrow(
    demos: { rpc_url: string; strictCapabilities?: boolean },
    requiredVersion: string,
    wireName: string,
    actualVersion: string | undefined,
): void {
    if (demos.strictCapabilities) {
        throw new MethodNotSupportedError({
            wireName,
            requiredVersion,
            actualVersion,
            rpcUrl: demos.rpc_url,
        })
    }
    const key = `${demos.rpc_url}::${wireName}`
    if (!warnedKeys.has(key)) {
        warnedKeys.add(key)
        const v = actualVersion ? ` (got ${actualVersion})` : " (version unknown)"
        // eslint-disable-next-line no-console
        console.warn(
            `[DEPRECATION] "${wireName}" requires node >= ${requiredVersion}${v}. ` +
            `In a future major release, calling this against an older node will ` +
            `throw MethodNotSupportedError. To opt in now, construct ` +
            `Demos({ strictCapabilities: true }).`,
        )
    }
}

/**
 * Legacy decorator. Apply to instance methods on classes whose `this` carries
 * an `rpc_url` (Demos, ContractInteractor wrapping a Demos, Web2Proxy with
 * `_demos`) — adapt the resolver if `rpc_url` lives elsewhere.
 *
 * For static methods (StorageProgram), see `minNodeVersionStatic` below.
 */
export function minNodeVersion(requiredVersion: string, wireName?: string) {
    return function <T extends { rpc_url?: string; strictCapabilities?: boolean; _demos?: any }>(
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const original = descriptor.value
        const wn = wireName ?? propertyKey
        descriptor.value = async function (this: T, ...args: any[]) {
            const demos = (this as any)._demos ?? this
            await assertNodeVersion(demos, requiredVersion, wn)
            return original.apply(this, args)
        }
        return descriptor
    }
}

/**
 * Static-method variant. The first arg of the decorated method must be the
 * rpcUrl (matches StorageProgram convention).
 *
 * Strict mode: read off a module-level config (`setStaticStrictCapabilities`)
 * since static methods don't carry instance state. Defaults to false.
 */
let staticStrict = false
export function setStaticStrictCapabilities(v: boolean) { staticStrict = v }

export function minNodeVersionStatic(requiredVersion: string, wireName?: string) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const original = descriptor.value
        const wn = wireName ?? propertyKey
        descriptor.value = async function (rpcUrl: string, ...rest: any[]) {
            await assertNodeVersion(
                { rpc_url: rpcUrl, strictCapabilities: staticStrict },
                requiredVersion,
                wn,
            )
            return original.call(this, rpcUrl, ...rest)
        }
        return descriptor
    }
}

/** Test/integration helper. */
export function _resetCapabilitiesCacheForTests() {
    urlCache.clear()
    inflight.clear()
    warnedKeys.clear()
    staticStrict = false
}
```

> **Sanity check while implementing:** `import("axios")` lazy import vs. top-level — pick whichever the rest of the SDK already does. Top-level is fine; the lazy import in the snippet is just to keep the file self-contained.

### 5.3 `Demos` constructor — accept `strictCapabilities`

**Path:** `sdks/src/websdk/demosclass.ts`

Find the `Demos` constructor (read it first; ~line 100-ish) and add an optional options object. Today's no-arg construction must still work.

```ts
constructor(opts?: { strictCapabilities?: boolean }) {
    // ... existing init ...
    this.strictCapabilities = opts?.strictCapabilities ?? false
}

public strictCapabilities: boolean = false
```

### 5.4 Reactive 404 detection in `Demos.call`

When the node returns `result: 404` with body shape `{error: "Unknown message", message: "<wireName>"}`, that's the Phase-1-item-1 shape (originating in `kynesyslabs/node`). Treat it as `MethodNotSupportedError` material on the SDK side.

**Recommended location:** `Demos.call` (`sdks/src/websdk/demosclass.ts:828`). Do NOT modify `_doPost` directly — `_doPost` is HTTP-level, not RPC-aware. `call` is where the RPC envelope is unpacked.

Sketch:

```ts
// Inside Demos.call, after getting the response envelope:
if (
    response.result === 404 &&
    response.response &&
    typeof response.response === "object" &&
    (response.response as any).error === "Unknown message"
) {
    const wireName = (response.response as any).message ?? "<unknown>"
    if (this.strictCapabilities) {
        throw new MethodNotSupportedError({
            wireName,
            requiredVersion: "(unknown — node returned Unknown message)",
            rpcUrl: this.rpc_url,
        })
    }
    const key = `${this.rpc_url}::${wireName}`
    if (!warnedKeys.has(key)) {  // import dedup helper from capabilities.ts
        warnedKeys.add(key)
        console.warn(
            `[DEPRECATION] Node at ${this.rpc_url} does not support "${wireName}". ` +
            `Future SDK versions will throw MethodNotSupportedError. ` +
            `Opt in now via new Demos({ strictCapabilities: true }).`,
        )
    }
}
```

> **Important:** the reactive path **must not change the return shape** in default mode. Existing call sites rely on `response.result !== 200 → null` patterns. Throw only when `strictCapabilities` is on.

### 5.5 Apply decorators / helpers

**Static decorator on `sdks/src/storage/StorageProgram.ts`** (illustrative):

```ts
import { minNodeVersionStatic } from "../websdk/capabilities"

export class StorageProgram {
    @minNodeVersionStatic("0.9.9", "getStorageProgram")
    static async getByAddress(rpcUrl: string, storageAddress: string, identity?: string) {
        // ... unchanged body ...
    }
    // ...repeat for other 8 methods, each with the right wireName...
}
```

> Repeat for all 9 storage methods. The `wireName` argument is **mandatory** for `getByAddress`/`getAll` (because they map to different/aliased wire names than the property name). Pass it explicitly to avoid mistakes.

**Inline helper on `sdks/src/websdk/DemosTransactions.ts`** (illustrative):

```ts
import { assertNodeVersion } from "./capabilities"

broadcastAndWait: async function (validationData, demos, opts) {
    await assertNodeVersion(demos, "0.9.9", "getTransactionStatus")
    // ... unchanged body, which polls getTransactionStatus ...
}
```

### 5.6 Hook `Demos.connect()` to warm the cache (optional but recommended)

**Path:** `sdks/src/websdk/demosclass.ts:140`

`connect()` already does a GET to verify reachability. Extend to fetch `/health` once and prime the cache. Failure is non-fatal — just don't cache.

```ts
async connect(rpc_url: string) {
    // ... existing reachability check ...
    this.rpc_url = rpc_url
    this.connected = true
    // Warm the version cache; ignore failure.
    void getNodeVersion(rpc_url)
    return this.connected
}
```

## 6. Min-version table (initial)

Apply decorators/helpers ONLY to these 10 methods in this PR. **Do NOT decorate pre-existing methods.** Pre-existing methods are assumed to work on all supported node versions; gating them retroactively risks breaking working clients.

| Wire | Min node version | SDK call site (`kynesyslabs/sdks`) |
|---|---|---|
| `getTransactionStatus` | `0.9.9` | `sdks/src/websdk/DemosTransactions.ts` `broadcastAndWait` (inline helper — not a class method) |
| `getStorageProgram` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getByAddress` (decorator) + `getAll` (decorator, same wire) |
| `getStorageProgramsByOwner` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getByOwner` |
| `searchStoragePrograms` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `searchByName` |
| `getStorageProgramFields` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getFields` |
| `getStorageProgramValue` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getValue` |
| `getStorageProgramItem` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getItem` |
| `hasStorageProgramField` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `hasField` |
| `getStorageProgramFieldType` | `0.9.9` | `sdks/src/storage/StorageProgram.ts` `getFieldType` |

> **Confirm the `0.9.9` figure with the team.** `APP_VERSION` in `node/src/utilities/constants.ts:9` was `0.9.8` at the start of this work. It should be bumped on the node side when Phase 1 + 2 lands. If the team picks a different version, edit this table accordingly before applying.

## 7. PR breakdown (recommended)

The user has not committed to one-PR-vs-three. Default plan: **3 PRs** for reviewability. If the user prefers one PR, flatten.

### PR 9.1 — infrastructure only (`kynesyslabs/sdks`)

Files (all in `kynesyslabs/sdks`):
- New: `sdks/src/websdk/MethodNotSupportedError.ts`
- New: `sdks/src/websdk/capabilities.ts`
- Modified: `sdks/src/websdk/index.ts` (export new error)
- Modified: `sdks/src/websdk/demosclass.ts` (constructor opts + reactive 404 handler in `Demos.call` + `connect()` warming)
- Modified: `sdks/tsconfig.json` (`experimentalDecorators: true`)

**No method decorations yet.** This PR only ships the mechanism. Self-test by writing a tiny standalone TS file under `/tmp/` (do not commit) that:
1. Mocks an `rpc_url` to a server returning `result: 404` with the unknown-message body.
2. Calls `Demos.call(...)` with `strictCapabilities: false` → expects warn + envelope returned.
3. Calls with `strictCapabilities: true` → expects `MethodNotSupportedError` thrown.

Commit message:
```
sdk: add capability detection infrastructure (item 9 part 1)

Adds the mechanism for detecting and gating unsupported node RPC methods,
without yet applying it to any specific method.

  - MethodNotSupportedError: typed error class
  - capabilities.ts: @minNodeVersion / @minNodeVersionStatic decorators,
    assertNodeVersion() helper, per-rpcUrl version cache (5 min TTL,
    singleflight), deprecation warn dedup
  - Demos constructor accepts { strictCapabilities?: boolean } (default false)
  - Demos.call detects Phase-1-item-1 "Unknown message" 404s; warns or
    throws based on the flag
  - Demos.connect() warms the version cache via /health (best effort)
  - tsconfig: experimentalDecorators=true (legacy decorators)

Default behavior preserved: methods returning null on 404 continue to do
so, but emit a deprecation console.warn (deduplicated per rpcUrl/wireName)
the first time the path is hit. To get throws today, opt in via
new Demos({ strictCapabilities: true }).
```

### PR 9.2 — apply gating to the 10 new methods (`kynesyslabs/sdks`)

Files (all in `kynesyslabs/sdks`):
- Modified: `sdks/src/storage/StorageProgram.ts` (`@minNodeVersionStatic("0.9.9", "<wireName>")` on 9 static methods)
- Modified: `sdks/src/websdk/DemosTransactions.ts` (`assertNodeVersion(demos, "0.9.9", "getTransactionStatus")` at top of `broadcastAndWait`)
- Test scaffolding if a test harness exists (audit found `sdks/src/tests/storagePrograms.spec.ts` is `test.skip` — skip is fine; not adding tests in this PR unless trivial)

Commit message:
```
sdk: apply @minNodeVersion to Phase 1+2 RPC additions (item 9 part 2)

Gates the 10 SDK methods that require node >= 0.9.9 (Phase 1 item 4 +
Phase 2 item 7 additions):

  - DemosTransactions.broadcastAndWait (uses getTransactionStatus)
  - StorageProgram.{getByAddress, getByOwner, searchByName, getFields,
    getValue, getItem, hasField, getFieldType, getAll}

Default mode logs a deprecation warning when the connected node lacks
support; strict mode throws MethodNotSupportedError. No pre-existing
method is decorated — gating older methods retroactively risks breaking
working clients.
```

### PR 9.3 — docs & changelog

- New: `sdks/docs/sdk-version-compat.md` (or wherever the SDK keeps its docs) — table of SDK version → required node version per method.
- Hand-off brief for Mintlify docs (the docs repo is `kynesyslabs/documentation-mintlify`, **outside the implementer's GitHub MCP scope** — produce a brief Markdown that lists each docs page that needs an entry, the same way `node/docs/planning/` is used here).
- README/CHANGELOG entries in `kynesyslabs/sdks`.

## 8. Verification checklist (before pushing PR 9.1)

1. Branch is `claude/checkout-branches-WQCIg` in `kynesyslabs/sdks`. **Do NOT commit on `main`.** Run `cd /home/user/sdks && git rev-parse --abbrev-ref HEAD` first.
2. `cd /home/user/sdks && cat package.json | grep version` — note the SDK version. Bump if the team has a convention; otherwise leave for release engineering.
3. `cd /home/user/sdks && bun run build` — must succeed. Pre-existing baseline is 1 error in `sdks/src/tests/multichain/ten.spec.ts:115`. Anything new is your problem.
4. `cd /home/user/node && git status` — must be clean. **No node changes — `kynesyslabs/node` is read-only for this work.**
5. Smoke: write a 30-line script under `/tmp/` (do not commit) that constructs a `Demos`, points it at a mock URL, and exercises the strict/non-strict paths. Confirm warns are deduplicated and throws fire when expected.

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | `experimentalDecorators` flips output behavior | Test build before applying decorators. Most likely flag is harmless; if surprises, fall back to wrapper functions instead of decorators. |
| 2 | `emitDecoratorMetadata: false` works only if no decorator imports `reflect-metadata` | The provided `capabilities.ts` does NOT use `reflect-metadata`. Keep it that way. |
| 3 | Static decorator + URL-keyed cache race | `inflight` map in `getNodeVersion` provides singleflight. |
| 4 | Node lacks `/health` (pre-Phase-1) | `getNodeVersion` returns `null` on failure; `assertNodeVersion` treats null as "unsupported". User sees deprecation warn or `MethodNotSupportedError` with `actualVersion: undefined`. |
| 5 | Custom node builds don't bump `APP_VERSION` | Strict mode is opt-in for exactly this reason. Document. |
| 6 | Deprecation noise spams long-running apps | Per-`(rpcUrl, wireName)` Set-based dedup. |
| 7 | Test coverage breaks | Audit found relevant tests are `.skip`'d. Spot-check before committing. |
| 8 | `StorageProgram.getAll` and `StorageProgram.getByAddress` share wire name `getStorageProgram` | Both get `@minNodeVersionStatic("0.9.9", "getStorageProgram")` — the wireName arg is explicit; no collision. |
| 9 | Multi-instance `Demos` with different URLs | Per-rpcUrl cache handles this naturally. |
| 10 | `Demos.connect` fetching `/health` adds latency | `void getNodeVersion(...)` (fire-and-forget). The decorator's `assertNodeVersion` will await it on first method call anyway. |

## 10. Open decisions for the implementer

If the user has not made the call before you start, **flag and ask**:

1. **Min node version for the gated methods** — currently `0.9.9` placeholder. Should match the actual `APP_VERSION` Phase 1+2 ships as.
2. **`strictCapabilities` shape**: simple `boolean` (recommended, matches this doc) vs. granular object (`{strict, warnOnce, ...}`). Default to boolean.
3. **One PR vs. three**: this doc proposes three for review. If the user wants one, collapse `9.1`+`9.2` into a single commit.
4. **Where docs go** in `sdks/docs/`. Only relevant for PR 9.3.

## 11. Repo boundary — explicit do-not-touch list

| Repo | Allowed? | What |
|---|---|---|
| `kynesyslabs/sdks` | ✅ YES | All implementation work happens here. Branch `claude/checkout-branches-WQCIg`. |
| `kynesyslabs/node` | ❌ **NO** | Read-only. The `/health` endpoint, `result: 404` for unknown messages, and the 9 storage-program read RPCs are all already shipped and pushed. |
| `kynesyslabs/documentation-mintlify` | ❌ **NO** (out of scope) | Docs hand-off in PR 9.3 produces a Markdown brief; another agent with that repo in scope ships it. |

## 12. What is explicitly out of scope

- **Node changes.** Already covered above — `kynesyslabs/node` is frozen for this work.
- **Test framework upgrades.** If existing tests don't run, that's a pre-existing issue (Phase 1 item 6 audit found 800+ pre-existing TS errors in tests).
- **Decorating pre-existing methods.** Only the 10 methods in §6.
- **Migrating callers off the legacy null-return pattern.** That's a major-version effort, separate.
- **`reflect-metadata` integration.** Don't introduce it.

## 13. Cross-references

- **Phase 1 item 4 commit** (introduces `getTransactionStatus`): `node:0def623` on `kynesyslabs/node` `claude/checkout-branches-WQCIg`.
- **Phase 1 item 5 commit** (introduces `/health`): `node:564f0af` on `kynesyslabs/node` `claude/checkout-branches-WQCIg`.
- **Phase 1 item 1 commit** (404 for unknown messages): `node:e57be21` on `kynesyslabs/node` `claude/checkout-branches-WQCIg`.
- **Phase 2 item 7 commit** (storage-program reads): `node:2b97270` on `kynesyslabs/node` `claude/checkout-branches-WQCIg`.
- **Phase 1 item 6 commit** (`_doPost` + `TransportError`): `sdks:5f0076d` on `kynesyslabs/sdks` `claude/checkout-branches-WQCIg`.
- **Phase 1 item 8 commit** (`broadcastAndWait`): `sdks:c6a6d26` on `kynesyslabs/sdks` `claude/checkout-branches-WQCIg`.

## 14. When done

1. Push the branch to `kynesyslabs/sdks`.
2. Report back with: PR(s) opened, decorated methods list, test-run summary, anything that surprised you.
3. **Stop.** Do NOT touch `kynesyslabs/node`. Do NOT proactively chase the docs PR — that's a separate hand-off.
