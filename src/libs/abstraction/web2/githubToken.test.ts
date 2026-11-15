/**
 * When GitHub rejects the node's own GITHUB_TOKEN (#1027) every gist read
 * fails, whoever sends the proof. The refusal has to name that cause, and the
 * operator's log has to carry it, once per refused link. The client is the
 * real Octokit, against a local origin that answers as GitHub does.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// Read when the config first loads, so set before the modules are imported.
process.env.GITHUB_TOKEN ||= "test-token"

const { GithubProofParser } = await import("./github")
const { verifyWeb2Proof } = await import("@/libs/abstraction")
const { default: log } = await import("src/utilities/logger")

const TOKEN_REJECTED =
    "this node's GitHub token was rejected by GitHub (expired or revoked); the node operator must renew GITHUB_TOKEN"

let answer: { status: number; body: object }
const seen: Array<string | null> = []

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
        seen.push(req.headers.get("authorization"))
        return Response.json(answer.body, { status: answer.status })
    },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

const badCredentials = {
    status: 401,
    body: {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
        status: "401",
    },
}

async function localParser() {
    const parser = new GithubProofParser()
    await parser.login()
    const octokit = (parser as any).github
    ;(parser as any).github = {
        request: (route: string, params: object) =>
            octokit.request(route, { ...params, baseUrl: base }),
    }
    return parser
}

async function readGist(): Promise<Error | undefined> {
    const parser = await localParser()
    try {
        await parser.readData("https://gist.github.com/alice/a1b2", {
            username: "alice",
            userId: "1",
        })
    } catch (error) {
        return error as Error
    }
}

describe("GitHub rejects the node's token", () => {
    let errors: ReturnType<typeof spyOn>
    let now = Date.now()

    beforeEach(() => {
        seen.length = 0
        answer = badCredentials
        errors = spyOn(log, "error").mockImplementation(() => null)
        // An hour past the previous test, so a log limited by time could not
        // hide a duplicate line.
        now += 3_600_000
        spyOn(Date, "now").mockImplementation(() => now)
    })

    afterEach(() => {
        errors.mockRestore()
        ;(Date.now as any).mockRestore()
    })

    it("refuses with the cause instead of GitHub's bare message", async () => {
        const err = await readGist()
        expect(err?.message).toBe(TOKEN_REJECTED)
    })

    it("asks GitHub once, with the token, and does not retry without it", async () => {
        await readGist()
        expect(seen).toEqual([`token ${process.env.GITHUB_TOKEN}`])
    })

    it("logs each refused link once, through the verifier, with the cause", async () => {
        const getParser = spyOn(GithubProofParser, "getInstance").mockResolvedValue(
            await localParser(),
        )
        const link = {
            context: "github",
            username: "alice",
            userId: "1",
            proof: "https://gist.github.com/alice/a1b2",
        } as any
        try {
            for (let i = 0; i < 2; i++) {
                expect(await verifyWeb2Proof(link, "ab".repeat(32))).toEqual({
                    success: false,
                    message: TOKEN_REJECTED,
                })
            }
        } finally {
            getParser.mockRestore()
        }
        const reports = errors.mock.calls.filter(c => String(c[0]).includes(TOKEN_REJECTED))
        expect(reports.length).toBe(2)
    })

    it("keeps GitHub's answer for other failures", async () => {
        answer = {
            status: 404,
            body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
        }
        const err = await readGist()
        expect(err?.message).toBe("Not Found - https://docs.github.com/rest")
        expect(errors.mock.calls.some(c => String(c[0]).includes(TOKEN_REJECTED))).toBe(false)
    })
})

it("runs in the consensus suite, so CI keeps checking it", () => {
    const script = readFileSync(path.resolve(import.meta.dir, "../../../../scripts/test-consensus.sh"), "utf8")
    const suiteFiles = script.match(/SUITE_FILES=\(([\s\S]*?)\n\)/)?.[1]
    expect(suiteFiles?.split(/\s+/)).toContain("src/libs/abstraction/web2/githubToken.test.ts")
})
