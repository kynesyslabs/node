# Dependency Audit Report

**Date**: 2026-04-08
**Branch**: `audit` (from `stabilisation`)
**Tool**: `bun audit v1.3.3`

## Summary

| Metric | Before | After |
|--------|--------|-------|
| Total | 97 | **85** |
| Critical | 4 | **3** |
| High | 55 | **47** |
| Moderate | 28 | **26** |
| Low | 10 | **9** |

## What Was Fixed

### Direct dependency bumps
- **express** 4.19.2 → 4.21.2 (2 critical CVEs)
- **socket.io** 4.7.1 → 4.8.1 (parser + engine.io high CVEs)
- **socket.io-client** 4.7.2 → 4.8.1
- **axios** 1.6.5 → 1.12.2 (3 moderate SSRF/header injection)

### Transitive dependency overrides (package.json `overrides`)
- **ws** >=8.17.1 (high DoS via HTTP headers)
- **socket.io-parser** >=4.2.6 (high unbounded binary attachments)
- **valibot** >=1.2.0 (high ReDoS in emoji regex)
- **fast-xml-parser** >=5.3.4 (critical+high entity expansion/injection)
- **validator** >=13.15.20 (high URL validation bypass)

---

## Remaining Vulnerabilities (85)

### False Positives (bun audit version range mismatches)

These are reported because `bun audit` matches the advisory's version range against the
installed version, but the actual vulnerability doesn't affect the installed major version.

| Package | Installed | Vuln Range | Why False Positive |
|---------|-----------|------------|-------------------|
| **fastify** | 4.29.1 | <=5.7.2 | All 3 CVEs are 5.x-only (sendWebStream, Content-Type tab, X-Forwarded). Dismissed on GitHub. |
| **path-to-regexp** | 0.1.12 | >=8.0.0 <8.4.0 | Vuln is in 8.x branch; express 4.x uses 0.x |
| **body-parser** | 1.20.3 | >=2.2.0 <2.2.1 | Vuln is in 2.x; express 4.x uses 1.x |
| **@solana/web3.js** | 1.98.4 | >=1.89.0 <1.89.2 | Installed version is well past the patched 1.89.2 |
| **qs** (via express) | 6.13.0 | >=6.7.0 <=6.14.1 | Express 4.21 uses qs via body-parser 1.x which is not affected by the 2.x advisory |

### Dev-Only Dependencies (no production risk)

| Package | Severity | Via | Notes |
|---------|----------|-----|-------|
| **handlebars** | Critical x1, High x4, Moderate x2, Low x1 | ts-jest | Template engine, never runs in production |
| **cross-spawn** | High | eslint, jest, prettier, npm-check-updates, ts-node-dev | Process spawning, only in dev/build tools |
| **picomatch** | High, Moderate | knip, ts-jest, jest, npm-check-updates, @typescript-eslint | Glob matching in dev tools |
| **minimatch** | High | eslint, npm-check-updates, jest, snarkjs, sqlite3 | Glob matching, not user-input reachable |
| **brace-expansion** | Moderate | eslint, npm-check-updates, typeorm, jest, snarkjs, sqlite3 | Brace expansion in glob, dev-only paths |
| **got** | Moderate | npm-check-updates | HTTP client in npm-check-updates (dev tool) |

### Unfixable Transitive Dependencies (rubic-sdk / web3 legacy tree)

These are deep in the dependency tree of third-party packages. Cannot be fixed without
the upstream package releasing an update. Low exploitability in RPC node context.

| Package | Severity | Via | Notes |
|---------|----------|-----|-------|
| **dset** | High | rubic-sdk > @0x/utils | Prototype pollution. Requires rubic-sdk update. |
| **axios** (transitive) | Moderate | rubic-sdk, @metaplex-foundation/js | Direct dep bumped, but transitive consumers pin older versions. |
| **tough-cookie** | Moderate | web3 > swarm-js > servify > request | Dead code path (Swarm not used) |
| **request** | Critical | web3 > swarm-js > servify > request | Deprecated package in legacy web3 tree |
| **ajv** | Moderate | web3 > swarm-js > servify > request > har-validator | Legacy web3 tree |
| **tar** | High | web3 > swarm-js | Legacy web3 tree |
| **form-data** | Moderate | web3 > swarm-js > servify > request | Legacy web3 tree |
| **jsonpath** | Critical, High | rubic-sdk > @0x/asset-swapper | Arbitrary code injection. Requires rubic-sdk update. |
| **ip** | High | @metaplex-foundation/js > @irys/sdk > pac-proxy-agent | SSRF bypass, unused code path |
| **jose** | Moderate | @metaplex-foundation/js > @irys/sdk > arbundles | JWT algo confusion, unused code path |
| **web3-core-subscriptions** | Low | rubic-sdk > web3-eth, web3 > web3-net | Prototype pollution in legacy web3 2.x |
| **min-document** | Low | web3 > swarm-js > servify | DOM shim, never loaded in Node.js |

### Crypto Libraries (theoretical side-channel, not remotely exploitable)

| Package | Severity | Via | Notes |
|---------|----------|-----|-------|
| **elliptic** | Low | ethers, demosdk, web3, rubic-sdk | Timing side-channel in ECDSA. Ecosystem migrating to @noble/curves. |
| **secp256k1** | Low | demosdk > ethereum-cryptography | Same class as elliptic. Not remotely exploitable. |
| **bn.js** | Moderate | anchor, metaplex, solana, ethers, web3 | Infinite loop on BigNumber parse. Low risk — most inputs are numeric. |

### Other Low-Risk Production Dependencies

| Package | Severity | Via | Notes |
|---------|----------|-----|-------|
| **@smithy/config-resolver** | Low | @metaplex-foundation/js > @aws-sdk | AWS SDK config, not attacker-reachable |
| **cookie** | Low | express | RPC server, no cookie-based auth |
| **node-forge** | High x4 | direct + demosdk | Certificate chain / signature issues. Used for crypto operations — **monitor for upstream fix** |
| **@modelcontextprotocol/sdk** | High x3 | direct | ReDoS, data leak, DNS rebinding. **Should be bumped to >=1.25.2 when available** |
| **socket.io** | Moderate | direct | `socket.io` server moderate vuln (CORS bypass) — low risk in internal node comms |
| **engine.io** | High | socket.io > engine.io | Resource exhaustion — mitigated by socket.io 4.8.1 bump |

---

## Recommendations for Future Audits

1. **rubic-sdk**: Largest source of unfixable transitive vulns (jsonpath critical, dset, legacy web3 tree). Monitor for rubic-sdk updates or evaluate replacement.
2. **node-forge**: 4 high-severity crypto vulns. Consider migration path to `@noble/curves` + native Node.js crypto.
3. **@modelcontextprotocol/sdk**: Bump to >=1.25.2 when compatible version is available.
4. **Dev deps cleanup**: Move `npm-check-updates`, `prettier`, `rollup-plugin-polyfill-node` to `devDependencies` to reduce production audit surface.
5. **bun audit**: Has significant false-positive rate on major version ranges. Cross-reference with actual installed versions before acting.
