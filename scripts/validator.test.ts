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

describe("validator.ts identity file selection", () => {
    let server: ReturnType<typeof Bun.serve>
    let hits = 0

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch: () => (hits++, new Response("{}")),
        })
    })

    afterAll(() => {
        server.stop(true)
    })

    const refusal = (value = "from-dotenv.id", source = ".env") =>
        `${source} sets IDENTITY_FILE=${value}; the node uses that file or ` +
        ".demos_identity depending on how it is started; " +
        "pass --identity <file> with the file the node runs as."
    const REFUSAL = refusal()

    // Runs the tool in a fresh directory holding `.env` (if given) and the
    // named identity files. The files are empty, so a run that gets past the
    // choice stops with "identity file not found: <file>" or "identity file is
    // empty: <file>" without signing, and that line names the file it picked.
    // IDENTITY_FILE and HTTP_PROXY come only from `env`; the caller's own
    // values are dropped.
    // By default the run stands in for the documented `bun run validator:*`,
    // which runs the script with `bunx tsx` under Node: `--no-env-file` stops
    // bun from reading ./.env itself and a preload hides process.versions.bun.
    // `bun` runs it as plain `bun scripts/validator.ts`, which loads .env into
    // the environment. `preload` is more code to run before the script.
    async function run(opts: {
        env?: Record<string, string>
        flags?: string[]
        dotenv?: string
        files?: string[]
        bun?: boolean
        preload?: string
    }): Promise<{ code: number; out: string; hits: number }> {
        const dir = mkdtempSync(join(tmpdir(), "validator-identity-"))
        try {
            if (opts.dotenv !== undefined) {
                writeFileSync(join(dir, ".env"), opts.dotenv)
            }
            for (const f of opts.files ?? []) writeFileSync(join(dir, f), "")
            const preload =
                (opts.bun ? "" : "delete process.versions.bun\n") +
                (opts.preload ?? "")
            writeFileSync(join(dir, "preload.mjs"), preload)
            const env: Record<string, string> = {}
            for (const [k, v] of Object.entries(process.env)) {
                const dropped = k === "IDENTITY_FILE" || k === "HTTP_PROXY"
                if (!dropped && v !== undefined) env[k] = v
            }
            hits = 0
            // Async spawn so this process can answer the tool's request.
            const proc = Bun.spawn(
                [
                    process.execPath,
                    ...(opts.bun ? [] : ["--no-env-file"]),
                    "--preload",
                    join(dir, "preload.mjs"),
                    SCRIPT,
                    "unstake",
                    "--rpc",
                    server.url.origin,
                    ...(opts.flags ?? []),
                ],
                {
                    cwd: dir,
                    env: { ...env, ...opts.env },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            )
            const [stdout, stderr, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ])
            return { code, out: stdout + stderr, hits }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    async function pickedFile(
        opts: Parameters<typeof run>[0],
    ): Promise<string> {
        const { out } = await run(opts)
        const m = out.match(/identity file (?:not found|is empty): (.*)/)
        expect(m).not.toBeNull()
        return m![1]
    }

    async function expectRefusal(
        opts: Parameters<typeof run>[0],
        message = REFUSAL,
    ) {
        const r = await run(opts)
        expect(r.out).toContain(message)
        expect(r.code).not.toBe(0)
        expect(r.out).not.toContain("identity file")
        expect(r.hits).toBe(0)
    }

    it("uses .demos_identity when neither the flag nor IDENTITY_FILE is set", async () => {
        expect(await pickedFile({})).toBe(".demos_identity")
    })

    it("uses an exported IDENTITY_FILE when there is no flag", async () => {
        expect(
            await pickedFile({ env: { IDENTITY_FILE: "from-env.id" } }),
        ).toBe("from-env.id")
    })

    it("lets --identity beat IDENTITY_FILE", async () => {
        expect(
            await pickedFile({
                env: { IDENTITY_FILE: "from-env.id" },
                flags: ["--identity", "from-flag.id"],
            }),
        ).toBe("from-flag.id")
    })

    it("lets an exported IDENTITY_FILE beat .env", async () => {
        expect(
            await pickedFile({
                env: { IDENTITY_FILE: "from-env.id" },
                dotenv: "IDENTITY_FILE=from-dotenv.id\n",
            }),
        ).toBe("from-env.id")
    })

    it("lets --identity beat .env", async () => {
        expect(
            await pickedFile({
                flags: ["--identity", "from-flag.id"],
                dotenv: "IDENTITY_FILE=from-dotenv.id\n",
            }),
        ).toBe("from-flag.id")
    })

    it("falls back to .demos_identity when IDENTITY_FILE is empty", async () => {
        expect(await pickedFile({ env: { IDENTITY_FILE: "" } })).toBe(
            ".demos_identity",
        )
    })

    // `./run` exports IDENTITY_FILE (empty without -i, so the node runs as
    // .demos_identity) while docker compose passes .env's value: when .env
    // names another file, the tool must not guess, whatever files exist.
    const BOTH = [".demos_identity", "from-dotenv.id"]
    const DOTENV = "IDENTITY_FILE=from-dotenv.id\n"

    for (const [name, files] of [
        ["both files exist", BOTH],
        ["only .env's file exists", ["from-dotenv.id"]],
        ["only .demos_identity exists", [".demos_identity"]],
        ["neither file exists", []],
    ] as const) {
        it(`refuses and sends nothing when .env names another file and ${name}`, async () => {
            await expectRefusal({ dotenv: DOTENV, files: [...files] })
        })
    }

    // Under plain `bun scripts/validator.ts`, bun has loaded .env (and
    // .env.local, with ${VAR} expansion) into the environment, so an exported
    // value cannot be told from a file value: only --identity picks a file
    // other than .demos_identity.
    describe("run directly under bun", () => {
        it("refuses when bun has loaded .env into the environment itself", async () => {
            await expectRefusal({ dotenv: DOTENV, files: BOTH, bun: true })
        })

        it("refuses when bun expands .env's value so it differs from the literal", async () => {
            await expectRefusal(
                {
                    env: { KEYDIR: "keys" },
                    dotenv: "IDENTITY_FILE=${KEYDIR}/from-dotenv.id\n",
                    files: BOTH,
                    bun: true,
                },
                refusal("${KEYDIR}/from-dotenv.id"),
            )
        })

        it("refuses an exported IDENTITY_FILE", async () => {
            await expectRefusal(
                {
                    env: { IDENTITY_FILE: "from-env.id" },
                    files: [".demos_identity", "from-env.id"],
                    bun: true,
                },
                refusal("from-env.id", "the environment"),
            )
        })

        it("refuses an exported IDENTITY_FILE when .env names .demos_identity", async () => {
            await expectRefusal(
                {
                    env: { IDENTITY_FILE: "from-env.id" },
                    dotenv: "IDENTITY_FILE=.demos_identity\n",
                    bun: true,
                },
                refusal("from-env.id", "the environment"),
            )
        })

        it("uses .demos_identity when no IDENTITY_FILE is set anywhere", async () => {
            expect(await pickedFile({ files: BOTH, bun: true })).toBe(
                ".demos_identity",
            )
        })

        it("uses .demos_identity when .env names the same file", async () => {
            expect(
                await pickedFile({
                    dotenv: "IDENTITY_FILE=./.demos_identity\n",
                    bun: true,
                }),
            ).toBe(".demos_identity")
        })

        it("lets --identity settle the choice", async () => {
            expect(
                await pickedFile({
                    env: { IDENTITY_FILE: "from-env.id" },
                    flags: ["--identity", "from-flag.id"],
                    dotenv: DOTENV,
                    bun: true,
                }),
            ).toBe("from-flag.id")
        })
    })

    it("chooses the identity from IDENTITY_FILE alone among the .env keys", async () => {
        const r = await run({ dotenv: "OTHER_KEY=1\nIDENTITY_FILE=\n" })
        expect(r.out).toContain("identity file not found: .demos_identity")
        expect(r.hits).toBeGreaterThan(0)
    })

    it("refuses when the exported value equals the one in .env", async () => {
        await expectRefusal({
            env: { IDENTITY_FILE: "from-dotenv.id" },
            dotenv: DOTENV,
            files: BOTH,
        })
    })

    it("refuses when IDENTITY_FILE is exported empty and .env names another file", async () => {
        await expectRefusal({
            env: { IDENTITY_FILE: "" },
            dotenv: DOTENV,
            files: BOTH,
        })
    })

    it("uses .demos_identity when .env names the same file", async () => {
        expect(
            await pickedFile({
                dotenv: "IDENTITY_FILE=./.demos_identity\n",
                files: [".demos_identity"],
            }),
        ).toBe(".demos_identity")
    })

    for (const [name, dotenv] of [
        ["sets no IDENTITY_FILE", "OTHER=1\n"],
        ["sets IDENTITY_FILE empty", "IDENTITY_FILE=\n"],
    ]) {
        it(`uses .demos_identity when .env ${name}`, async () => {
            expect(await pickedFile({ dotenv, files: BOTH })).toBe(
                ".demos_identity",
            )
        })
    }

    it("lets --identity settle the choice when both files exist", async () => {
        expect(
            await pickedFile({
                flags: ["--identity", "from-dotenv.id"],
                dotenv: DOTENV,
                files: BOTH,
            }),
        ).toBe("from-dotenv.id")
    })

    it("lets an exported IDENTITY_FILE beat .env when both files exist", async () => {
        expect(
            await pickedFile({
                env: { IDENTITY_FILE: "from-env.id" },
                dotenv: DOTENV,
                files: [...BOTH, "from-env.id"],
            }),
        ).toBe("from-env.id")
    })

    // A .env the tool cannot read (e.g. root-owned mode 600 while the tool
    // runs as the operator) may name the file the node runs as, so the tool
    // must not fall back to .demos_identity. A missing .env is no .env.
    // `failRead(code)` makes reads of ./.env fail with that error code, the
    // way fs reports it, while the file itself stays in place.
    const failRead = (code: string) =>
        "import fs from 'node:fs'\n" +
        "const read = fs.readFileSync\n" +
        "fs.readFileSync = (p, ...rest) => {\n" +
        "    if (!String(p).endsWith('/.env')) return read(p, ...rest)\n" +
        `    const e = new Error('${code}: cannot open ' + p)\n` +
        `    e.code = '${code}'\n` +
        "    throw e\n" +
        "}\n"
    const UNREADABLE = ".env could not be read (EACCES: cannot open "

    it("refuses and sends nothing when .env exists but cannot be read", async () => {
        const r = await run({
            dotenv: DOTENV,
            files: BOTH,
            preload: failRead("EACCES"),
        })
        expect(r.out).toContain(UNREADABLE)
        expect(r.out).toContain("/.env); pass --identity <file>")
        expect(r.code).not.toBe(0)
        expect(r.out).not.toContain("identity file")
        expect(r.hits).toBe(0)
    })

    it("refuses under plain bun when .env exists but cannot be read", async () => {
        await expectRefusal(
            {
                dotenv: "IDENTITY_FILE=.demos_identity\n",
                files: BOTH,
                bun: true,
                preload: failRead("EACCES"),
            },
            UNREADABLE,
        )
    })

    it("refuses when .env is not a readable file (a directory)", async () => {
        await expectRefusal(
            {
                files: [".demos_identity"],
                preload: "import fs from 'node:fs'\nfs.mkdirSync('.env')\n",
            },
            ".env could not be read (EISDIR",
        )
    })

    it("lets --identity settle the choice when .env cannot be read", async () => {
        expect(
            await pickedFile({
                flags: ["--identity", "from-flag.id"],
                dotenv: DOTENV,
                files: BOTH,
                preload: failRead("EACCES"),
            }),
        ).toBe("from-flag.id")
    })

    it("treats a .env read failing with ENOENT as no .env", async () => {
        const r = await run({
            dotenv: DOTENV,
            files: BOTH,
            preload: failRead("ENOENT"),
        })
        expect(r.out).toContain("identity file is empty: .demos_identity")
        expect(r.out).not.toContain(".env could not be read")
    })

    it("uses .demos_identity when there is no .env at all", async () => {
        const r = await run({ files: [] })
        expect(r.out).toContain("identity file not found: .demos_identity")
        expect(r.out).not.toContain(".env could not be read")
        expect(r.hits).toBeGreaterThan(0)
    })
})

describe("validator.ts stakeCommand", () => {
    it("keeps the identity and endpoints of the proof, quoted for a shell", async () => {
        const { stakeCommand } = await import("./validator")
        expect(stakeCommand("5ig", {})).toBe("bun run validator:stake --nft-proof 5ig")
        expect(
            stakeCommand("5ig", {
                identity: "/keys/my node's id",
                rpc: "http://10.0.0.2:53550",
                "solana-rpc": "https://rpc.example/?api-key=a&b",
                keypair: "solana.json",
            }),
        ).toBe(
            "bun run validator:stake --nft-proof 5ig --identity '/keys/my node'\\''s id' " +
                "--rpc http://10.0.0.2:53550 --solana-rpc 'https://rpc.example/?api-key=a&b'",
        )
    })
})

describe("validator.ts --amount", () => {
    it("keeps a bonded stake on a network without nftValidatorGating, or one that does not say", async () => {
        const { amountRefusal } = await import("./validator")
        expect(amountRefusal("stake", "1000", false)).toBeNull()
        expect(amountRefusal("stake", "1000", null)).toBeNull()
        expect(amountRefusal("stake", undefined, true)).toBeNull()
    })

    it("refuses it where nftValidatorGating is active, and on every command but stake", async () => {
        const { amountRefusal } = await import("./validator")
        expect(amountRefusal("stake", "1000", true)).toContain("this network runs nftValidatorGating")
        for (const command of ["unstake", "exit", "challenge", "nft-proof"]) {
            expect(amountRefusal(command, "1000", false)).toBe(`--amount is used only by stake, not by ${command}`)
        }
    })

    it("refuses --amount on another command before any network use", () => {
        const r = Bun.spawnSync([process.execPath, SCRIPT, "unstake", "--amount", "5", "--rpc", "http://127.0.0.1:9"], {
            stdout: "pipe",
            stderr: "pipe",
        })
        expect(r.exitCode).toBe(1)
        expect(String(r.stderr)).toContain("--amount is used only by stake, not by unstake")
    })
})
