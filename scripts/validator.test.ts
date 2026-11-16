import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "validator.ts")

it("runs the validator CLI and dormant-mode checks in consensus CI", () => {
    const suite = readFileSync(join(import.meta.dir, "test-consensus.sh"), "utf8")
    expect(suite).toContain("scripts/validator.test.ts")
    expect(suite).toContain("docs/runbooks/dormant-mode.test.ts")
})

describe("validator.ts peer list handling", () => {
    let dir: string

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "validator-peerlist-"))
    })

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    // Runs the tool without --rpc so it has to read demos_peerlist.json from
    // its working directory. "bogus" is not a command, so a peer list that is
    // accepted ends in the "unknown command" message without any network use.
    function run(peerlist: string) {
        writeFileSync(join(dir, "demos_peerlist.json"), peerlist)
        const r = Bun.spawnSync([process.execPath, SCRIPT, "bogus"], {
            cwd: dir,
            stdout: "pipe",
            stderr: "pipe",
        })
        return { code: r.exitCode, out: String(r.stdout) + String(r.stderr) }
    }

    for (const [name, content] of [
        ["null", "null"],
        ["an array", '["http://a"]'],
        ["a string", '"http://a"'],
        ["a number", "42"],
    ]) {
        it(`exits with a clear message when the peer list is ${name}`, () => {
            const r = run(content)
            expect(r.code).toBe(1)
            expect(r.out).toContain(
                "demos_peerlist.json must be an object of peer URLs. Pass --rpc <url>.",
            )
            expect(r.out).not.toContain("TypeError")
        })
    }

    // The node (src/libs/peer/PeerManager.ts) skips these entries too.
    for (const [name, content] of [
        ["a number", '{"k":1}'],
        ["an empty string", '{"k":""}'],
        ["a blank string", '{"k":"  "}'],
        ["null", '{"k":null}'],
        ["an array", '{"k":["http://a"]}'],
        ["an object without a url", '{"k":{}}'],
        ["an object with an empty url", '{"k":{"url":""}}'],
        ["an object with a blank url", '{"k":{"url":"  "}}'],
        ["an object with a non-string url", '{"k":{"url":1}}'],
    ]) {
        it(`skips the entry and exits when the only value is ${name}`, () => {
            const r = run(content)
            expect(r.code).toBe(1)
            expect(r.out).toContain(
                'demos_peerlist.json entry "k" is not a peer URL or an object with a url, skipping',
            )
            expect(r.out).toContain(
                "demos_peerlist.json has no usable entries. Pass --rpc <url>.",
            )
            expect(r.out).not.toContain("TypeError")
        })
    }

    it("skips bad entries before the first usable one and goes on", () => {
        const r = run('{"bad1":1,"bad2":null,"good":"http://a","bad3":null}')
        expect(r.out).toContain('demos_peerlist.json entry "bad1" is not a peer URL')
        expect(r.out).toContain('demos_peerlist.json entry "bad2" is not a peer URL')
        expect(r.out).not.toContain("bad3")
        expect(r.out).not.toContain("has no usable entries")
        expect(r.out).toContain("unknown command: bogus")
    })

    it("names the example's placeholder URL instead of trying to reach it", () => {
        const r = run(JSON.stringify({ "0xexample": "https://<host>:53550" }))
        expect(r.code).toBe(1)
        expect(r.out).toContain(
            'demos_peerlist.json entry "0xexample" has no usable URL ("https://<host>:53550"). Set a real validator URL, skipping',
        )
        expect(r.out).toContain("demos_peerlist.json has no usable entries. Pass --rpc <url>.")
    })

    it("skips a placeholder URL and goes on to the next usable entry", () => {
        const r = run('{"0xexample":{"url":"https://<host>:53550"},"good":"http://a"}')
        expect(r.out).toContain('entry "0xexample" has no usable URL')
        expect(r.out).not.toContain("has no usable entries")
        expect(r.out).toContain("unknown command: bogus")
    })

    it("exits with the no-usable-entries message on an empty object", () => {
        const r = run("{}")
        expect(r.code).toBe(1)
        expect(r.out).toContain(
            "demos_peerlist.json has no usable entries. Pass --rpc <url>.",
        )
    })

    for (const [name, content] of [
        [
            "URL strings",
            '{"k1":"http://first:53550","k2":"http://second:53550"}',
        ],
        [
            "objects with a url",
            '{"k1":{"url":"http://first:53550","capabilities":{}},"k2":{"url":"http://second:53550"}}',
        ],
        [
            "URL strings and objects with a url",
            '{"k1":"http://first:53550","k2":{"url":"http://second:53550"}}',
        ],
    ]) {
        it(`accepts a peer list of ${name}`, () => {
            const r = run(content)
            expect(r.out).toContain("unknown command: bogus")
            expect(r.out).not.toContain("demos_peerlist.json")
        })
    }

    // Each case maps the first and second local server to peer list entries;
    // "used" is the server the tool must contact, the other must stay unused.
    for (const [name, entries, used] of [
        [
            "the first entry's URL when it is a URL string",
            (a: string, b: string) => ({ k1: a, k2: { url: b } }),
            "first",
        ],
        [
            "the first entry's URL when it is an object with a url",
            (a: string, b: string) => ({ k1: { url: a }, k2: b }),
            "first",
        ],
        [
            "a's URL when a later entry is null",
            (a: string, _b: string) => ({ a, b: null }),
            "first",
        ],
        [
            "b's URL when the entry before it is null",
            (_a: string, b: string) => ({ a: null, b }),
            "second",
        ],
        [
            "b's URL when the entry before it has a blank url",
            (_a: string, b: string) => ({ a: { url: "  " }, b: { url: b } }),
            "second",
        ],
    ] as const) {
        it(`uses ${name}`, async () => {
            const hits = { first: 0, second: 0 }
            const first = Bun.serve({
                port: 0,
                fetch: () => (hits.first++, new Response("{}")),
            })
            const second = Bun.serve({
                port: 0,
                fetch: () => (hits.second++, new Response("{}")),
            })
            try {
                writeFileSync(
                    join(dir, "demos_peerlist.json"),
                    JSON.stringify(entries(first.url.origin, second.url.origin)),
                )
                // Async spawn so this process can answer the tool's request.
                await Bun.spawn([process.execPath, SCRIPT, "unstake"], {
                    cwd: dir,
                    stdout: "ignore",
                    stderr: "ignore",
                }).exited
                const unused = used === "first" ? "second" : "first"
                expect(hits[used]).toBeGreaterThan(0)
                expect(hits[unused]).toBe(0)
            } finally {
                first.stop(true)
                second.stop(true)
            }
        })
    }
})
