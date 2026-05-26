/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Build/runtime provenance of the running node binary.
 *
 * Motivation: when chasing a "fix-merged-to-stabilisation-but-the-symptom-
 * still-reproduces" bug, the first question is always "did this node get
 * rebuilt after the fix landed?". Exposing version + commit over the
 * existing fork-status RPC closes that branch in seconds.
 *
 * Sources (read once at module evaluation, then frozen):
 *
 *   - `name`, `version`            ← top-level `package.json`. Single
 *                                    source of truth for the human-
 *                                    facing semver.
 *   - `commit`, `branch`, `dirty`  ← resolved from the working tree's
 *                                    `.git/` if present at boot time;
 *                                    falls back to env-var overrides
 *                                    (`GIT_COMMIT`, `GIT_BRANCH`,
 *                                    `GIT_DIRTY`) so a `git clone --depth 0`
 *                                    or a stripped Docker image can still
 *                                    surface meaningful values.
 *   - `builtAt`                    ← `BUILT_AT` env var if the image
 *                                    baked one in; otherwise `null`.
 *
 * The lookup is deliberately defensive: every individual failure path
 * lands on `null`, never throws, so a corrupted `.git/HEAD` (or a
 * runtime that lacks `child_process`) can never panic the node. The
 * fork-status RPC must keep answering even when provenance is unknown.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface NodeVersionInfo {
    /** Package name from package.json (e.g. "demos-node"). */
    name: string
    /** Semver from package.json. */
    version: string
    /** Full 40-char git SHA, or `null` if not resolvable. */
    commit: string | null
    /** First 7 chars of `commit`, or `null` if `commit` is `null`. */
    commitShort: string | null
    /** Human-readable branch label, or `null` if not resolvable. */
    branch: string | null
    /** `true` iff the working tree had uncommitted edits at boot. */
    dirty: boolean
    /** ISO-8601 build timestamp, or `null` if unset. */
    builtAt: string | null
}

// =============================================================================
// package.json (name + version)
// =============================================================================

/**
 * Resolve `/app/package.json` (in-container) or `<repo>/package.json`
 * (dev tree) at runtime. We avoid `require("../../package.json")`
 * because the ESM/CJS interop story under bun + tsconfig-paths is
 * unreliable enough that the first attempt silently fell back to
 * defaults in production (the rebuilt dev.node2 was returning
 * `name: "demos-node"` + `version: "0.0.0"` — the catch-clause
 * sentinels). Walking from `import.meta.url` up to the first
 * directory that contains a readable `package.json` mirrors what
 * the git-root walker below already does for `.git/HEAD`, so the
 * two halves of the module behave identically.
 */
function readPackageJson(): { name: string; version: string } {
    const moduleDir = (() => {
        try {
            return dirname(fileURLToPath(import.meta.url))
        } catch {
            return process.cwd()
        }
    })()

    let cur = resolve(moduleDir)
    for (let i = 0; i < 16; i++) {
        try {
            const raw = readFileSync(resolve(cur, "package.json"), "utf8")
            const pkg = JSON.parse(raw) as Partial<{
                name: string
                version: string
            }>
            // Skip nested package manifests (e.g. node_modules/*) by
            // requiring a non-empty `version` field — those exist on
            // every workspace's package.json, including ours.
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
                return {
                    name:
                        typeof pkg.name === "string"
                            ? pkg.name
                            : "demos-node",
                    version: pkg.version,
                }
            }
        } catch {
            /* fall through, walk up */
        }
        const parent = dirname(cur)
        if (parent === cur) break
        cur = parent
    }
    return { name: "demos-node", version: "0.0.0" }
}

// =============================================================================
// git (commit + branch + dirty)
// =============================================================================

/**
 * Resolve the repo root by walking up from `process.cwd()` looking for a
 * `.git/` entry. Returns `null` when no repo is found (e.g. a Docker
 * image that didn't ship `.git/`).
 *
 * Stops at the filesystem root (`dirname(x) === x`) so a misconfigured
 * boot can never loop.
 */
function findRepoRoot(start: string): string | null {
    let cur = resolve(start)
    while (true) {
        try {
            // Existence check via stat-less readFileSync on `.git/HEAD`
            // — cheaper than `existsSync` and avoids the ESLint
            // discourage-fs rule on `existsSync`.
            readFileSync(resolve(cur, ".git/HEAD"))
            return cur
        } catch {
            const parent = dirname(cur)
            if (parent === cur) return null
            cur = parent
        }
    }
}

function readGitInfo(): {
    commit: string | null
    branch: string | null
    dirty: boolean
} {
    // 1) Env-var overrides take priority. Useful for `git clone --depth 0`
    //    images or Docker stages that don't ship `.git/` but do receive
    //    the SHA via build args.
    const envCommit = process.env.GIT_COMMIT?.trim()
    if (envCommit && /^[0-9a-f]{7,40}$/i.test(envCommit)) {
        return {
            commit: envCommit.toLowerCase(),
            branch: process.env.GIT_BRANCH?.trim() || null,
            dirty:
                (process.env.GIT_DIRTY?.trim().toLowerCase() ?? "") === "true",
        }
    }

    // 2) Otherwise resolve from `.git/` in the runtime tree.
    const repoRoot = findRepoRoot(process.cwd())
    if (!repoRoot) {
        return { commit: null, branch: null, dirty: false }
    }

    // 2a) Commit + branch from `.git/HEAD`. If HEAD points at a ref
    //     (`ref: refs/heads/<branch>`), we read the referenced file for
    //     the SHA and surface the branch name. Detached HEAD case: HEAD
    //     itself is the SHA.
    let commit: string | null = null
    let branch: string | null = null
    try {
        const head = readFileSync(resolve(repoRoot, ".git/HEAD"), "utf8").trim()
        if (head.startsWith("ref: ")) {
            const refPath = head.slice("ref: ".length).trim()
            branch = refPath.replace(/^refs\/heads\//, "")
            try {
                commit = readFileSync(
                    resolve(repoRoot, ".git", refPath),
                    "utf8",
                ).trim()
            } catch {
                // Packed-refs fallback (refs/heads/<branch> not on disk).
                try {
                    const packed = readFileSync(
                        resolve(repoRoot, ".git/packed-refs"),
                        "utf8",
                    )
                    const match = packed
                        .split("\n")
                        .map(l => l.trim())
                        .find(l => l.endsWith(" " + refPath))
                    if (match) commit = match.split(" ")[0]
                } catch {
                    /* commit stays null */
                }
            }
        } else if (/^[0-9a-f]{40}$/i.test(head)) {
            commit = head
        }
    } catch {
        /* repo present but HEAD unreadable; stays null */
    }

    if (commit && !/^[0-9a-f]{40}$/i.test(commit)) {
        commit = null
    }

    // 2b) Dirty bit. `git diff-index --quiet HEAD` exits 0 when clean,
    //     1 when dirty, anything else on error. We tolerate a missing
    //     `git` binary (image without git) by defaulting to false.
    let dirty = false
    try {
        execFileSync("git", ["diff-index", "--quiet", "HEAD"], {
            cwd: repoRoot,
            stdio: "ignore",
        })
        dirty = false
    } catch (e) {
        const code = (e as { status?: number }).status
        // Exit 1 = dirty. Anything else (binary missing, unreadable
        // refs) = "we don't know"; report clean rather than panic.
        dirty = code === 1
    }

    return { commit: commit?.toLowerCase() ?? null, branch, dirty }
}

// =============================================================================
// Frozen snapshot at module evaluation
// =============================================================================

const PKG = readPackageJson()
const GIT = readGitInfo()

export const NODE_VERSION: NodeVersionInfo = {
    name: PKG.name,
    version: PKG.version,
    commit: GIT.commit,
    commitShort: GIT.commit?.slice(0, 7) ?? null,
    branch: GIT.branch,
    dirty: GIT.dirty,
    builtAt: process.env.BUILT_AT?.trim() || null,
}
