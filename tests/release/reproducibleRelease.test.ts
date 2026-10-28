/**
 * Gate 3 G3-4 — every validator runs identical, pinned code.
 *
 * Static repo-policy check: reads tracked files from the repo root, no
 * network, no install. Each `it` is one release rule; it fails until the
 * repo meets that rule. "Two independent builds of a release tag produce
 * matching artifacts" is a CI job, not a unit test, and is not covered here.
 */

import { describe, expect, it } from "@jest/globals"
import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const ROOT = join(__dirname, "..", "..")

function read(rel: string): string {
    return readFileSync(join(ROOT, rel), "utf8")
}

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
}

function tracked(pattern: string): string[] {
    return git("ls-files", "--", pattern).split("\n").filter(Boolean)
}

// Files that install or build what a validator runs.
const VALIDATOR_INSTALL_FILES = [
    "Dockerfile",
    "scripts/run",
    "scripts/install-deps.sh",
    ...tracked(".github/workflows/*.yml"),
]

const DOCKERFILES = tracked("Dockerfile").concat(tracked("**/Dockerfile"))

// Lines (file:line: text) matching `re`, ignoring shell/Dockerfile comments.
function offendingLines(files: string[], re: RegExp, ok?: RegExp): string[] {
    const hits: string[] = []
    for (const file of files) {
        read(file)
            .split("\n")
            .forEach((line, i) => {
                if (line.trim().startsWith("#")) return
                // Ignore quoted text (log messages), keep the command itself.
                const code = line.replace(/"[^"]*"|'[^']*'/g, "STR")
                if (re.test(code) && !(ok && ok.test(code))) {
                    hits.push(`${file}:${i + 1}: ${line.trim()}`)
                }
            })
    }
    return hits
}

describe("release policy (Gate 3 G3-4): validators run identical, pinned code", () => {
    it("bun.lock is committed and not git-ignored", () => {
        expect(tracked("bun.lock")).toEqual(["bun.lock"])
        let ignored = true
        try {
            git("check-ignore", "--no-index", "-q", "bun.lock")
        } catch {
            ignored = false // exit 1 = not ignored
        }
        expect(ignored).toBe(false)
    })

    it("every `bun install` on a validator install path uses --frozen-lockfile", () => {
        const unfrozen = offendingLines(
            VALIDATOR_INSTALL_FILES,
            /\bbun install\b/,
            /--frozen-lockfile/,
        )
        expect(unfrozen).toEqual([]) // each entry is an install that may rewrite the lockfile
    })

    it("the Bun version is pinned to an exact x.y.z (packageManager or .bun-version)", () => {
        const pkg = JSON.parse(read("package.json"))
        const fromPackageManager = /^bun@\d+\.\d+\.\d+$/.test(
            pkg.packageManager ?? "",
        )
        const hasBunVersionFile = existsSync(join(ROOT, ".bun-version"))
        const fromBunVersionFile =
            hasBunVersionFile && /^\d+\.\d+\.\d+\s*$/.test(read(".bun-version"))
        const problems =
            fromPackageManager || fromBunVersionFile
                ? []
                : [
                      `package.json packageManager is ${JSON.stringify(pkg.packageManager ?? null)}, ` +
                          `.bun-version ${hasBunVersionFile ? "is not an exact x.y.z" : "is missing"}`,
                  ]
        expect(problems).toEqual([])
    })

    it("package.json packageManager, when set, names the Bun in .bun-version", () => {
        const pkg = JSON.parse(read("package.json"))
        if (pkg.packageManager === undefined) return
        const wanted = read(".bun-version").trim()
        expect(pkg.packageManager).toBe(`bun@${wanted}`)
    })

    it("the bun npm package is not a dependency", () => {
        // It ships its own Bun binary into node_modules/.bin, a second
        // version next to the pinned runtime; `import ... from "bun"` is the
        // runtime's built-in module and its types come from @types/bun.
        const pkg = JSON.parse(read("package.json"))
        const declaredIn = [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        ].filter(field => pkg[field]?.bun !== undefined)
        expect(declaredIn).toEqual([])
    })

    it("every CI setup-bun step pins bun-version or bun-version-file", () => {
        const unpinned: string[] = []
        for (const file of tracked(".github/workflows/*.yml")) {
            const lines = read(file).split("\n")
            lines.forEach((line, i) => {
                if (!/uses:\s*oven-sh\/setup-bun@/.test(line)) return
                const step = lines.slice(i + 1, i + 5).join("\n")
                if (!/bun-version(-file)?\s*:/.test(step)) {
                    unpinned.push(`${file}:${i + 1}: ${line.trim()}`)
                }
            })
        }
        expect(unpinned).toEqual([]) // each entry installs whatever Bun is latest
    })

    it("no Dockerfile uses a :latest or untagged base image", () => {
        const floating: string[] = []
        for (const file of DOCKERFILES) {
            const stages = new Set<string>()
            read(file)
                .split("\n")
                .forEach((line, i) => {
                    const m = line.match(
                        /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i,
                    )
                    if (!m) return
                    const image = m[1]
                    if (m[2]) stages.add(m[2].toLowerCase())
                    if (image === "scratch" || stages.has(image.toLowerCase()))
                        return
                    const name = image.split("@")[0]
                    const tag = name.includes(":")
                        ? name.split(":").pop()
                        : undefined
                    if (
                        tag === "latest" ||
                        (!tag && !image.includes("@sha256:"))
                    ) {
                        floating.push(`${file}:${i + 1}: ${line.trim()}`)
                    }
                })
        }
        expect(floating).toEqual([])
    })

    it("every base image in the release Dockerfile is pinned by @sha256 digest", () => {
        const undigested = offendingLines(
            ["Dockerfile"],
            /^\s*FROM\s+/i,
            /@sha256:[0-9a-f]{64}/,
        )
        expect(undigested).toEqual([]) // tags like :1.3-debian or :1-slim are mutable
    })

    it("the compose Postgres image is pinned by tag and @sha256 digest", () => {
        const files = [
            "docker-compose.yml",
            "testing/devnet/docker-compose.yml",
            "testing/multinode/docker-compose.companion.yml",
            "postgres/docker-compose.yml",
        ]
        const images = files.flatMap(file =>
            [...read(file).matchAll(/^\s*image:\s*(postgres\S*)/gm)].map(
                m => `${file}: ${m[1]}`,
            ),
        )
        expect(images).toHaveLength(files.length)
        const undigested = images.filter(
            i => !/postgres:16-alpine@sha256:[0-9a-f]{64}$/.test(i),
        )
        expect(undigested).toEqual([])
        // one digest everywhere, so devnet tests the server validators run
        expect(new Set(images.map(i => i.split("@")[1])).size).toBe(1)
    })

    it("no install path runs a blanket `bun pm trust --all`", () => {
        const scripts = tracked("scripts/**").concat(tracked("run"))
        const blanket = offendingLines(
            [...new Set([...DOCKERFILES, ...scripts])],
            /bun pm trust\s+--all/,
        )
        expect(blanket).toEqual([]) // trust specific packages via trustedDependencies instead
    })

    it("the validator launcher does not git pull by default", () => {
        const defaultPull = offendingLines(["scripts/run"], /^GIT_PULL=true\b/)
        expect(defaultPull).toEqual([]) // ./run must start the checked-out release, not origin's head
    })

    it("the release workflow takes signers from the protected branch and requires the tag to be on it", () => {
        const workflow = read(".github/workflows/release.yml")
        const code = workflow
            .split("\n")
            .filter(line => !line.trim().startsWith("#"))
            .join("\n")
        expect(code).toMatch(/^\s*RELEASE_BRANCH:\s*\S+/m)
        expect(code).toMatch(
            /git show "origin\/\$RELEASE_BRANCH:\.github\/allowed_signers"/,
        )
        expect(code).toMatch(/git merge-base --is-ancestor/)
        // a path inside the checkout would let the tag supply its own signers
        expect(code).not.toMatch(/allowedSignersFile\s+\.github\/allowed_signers/)
    })

    it("the launcher answers -h before checking Bun or installing anything", () => {
        const run = read("scripts/run")
        const help = run.indexOf("-h | --help)")
        expect(help).toBeGreaterThan(-1)
        expect(help).toBeLessThan(run.indexOf("\ncheck_bun_version\n"))
        expect(help).toBeLessThan(run.indexOf("bun install --frozen-lockfile"))
    })

    it("every wstcp install names the same --version", () => {
        const files = [
            "Dockerfile",
            "scripts/install-deps.sh",
            "src/features/tlsnotary/proxyManager.ts",
        ]
        const sites: string[] = []
        const versions = new Set<string>()
        for (const file of files) {
            read(file)
                .split("\n")
                .forEach((line, i) => {
                    const code = line.trim()
                    if (code.startsWith("#") || code.startsWith("//")) return
                    if (/cargo\S*\s+install\s+wstcp\b/.test(code)) {
                        sites.push(`${file}:${i + 1}: ${code}`)
                    }
                })
            for (const m of read(file).matchAll(
                /WSTCP_VERSION\s*=\s*"?(\d+\.\d+\.\d+)|wstcp --version (\d+\.\d+\.\d+)/g,
            )) {
                versions.add(m[1] ?? m[2])
            }
        }
        expect(sites).toHaveLength(files.length)
        const unpinned = sites.filter(s => !/--version\b/.test(s))
        expect(unpinned).toEqual([]) // each entry installs whatever crates.io serves today
        expect([...versions]).toHaveLength(1)
    })
})
