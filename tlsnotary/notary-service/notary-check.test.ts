import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import { CHECK, chronycStub, makeKey, makeTmp, runAsync, spkiPemOf, timedatectlStub } from "./testSupport"

const ABSENT = "notary-test-no-such-command"

/** What the fake notary answers; each test sets it. */
let served: { health: number; publicKey: string | null }
let server: ReturnType<typeof Bun.serve>
let url: string
let dir: string
let key: { file: string; pub: string }

beforeAll(() => {
    // Mirrors the stock alpha.12 notary's /healthcheck and /info
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const p = new URL(req.url).pathname
            if (p === "/healthcheck") return new Response("Ok", { status: served.health })
            if (p === "/info") {
                return Response.json({
                    version: "0.1.0-alpha.12",
                    publicKey: served.publicKey,
                    gitCommitHash: "0".repeat(40),
                })
            }
            return new Response("not found", { status: 404 })
        },
    })
    url = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

beforeEach(() => {
    dir = makeTmp("notary-check")
    key = makeKey(dir, "notary.key")
    served = { health: 200, publicKey: spkiPemOf(key.file, "compressed") }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

// Async: curl calls back into the fake notary served by this process
const check = (env: Record<string, string | undefined> = {}) =>
    runAsync([CHECK], {
        NOTARY_URL: url,
        NOTARY_EXPECTED_PUBKEY: key.pub,
        NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "+1.2ms"),
        NOTARY_CHRONYC: ABSENT,
        NOTARY_CHECK_TIMEOUT_SEC: "2",
        ...env,
    })

describe("notary-check.sh", () => {
    it("passes a reachable notary on the pinned key and a synchronised clock", async () => {
        const r = await check()
        expect(r.status).toBe(0)
        expect(r.stdout).toContain(`OK   key ${key.pub} SHA256:`)
        expect(r.stdout).toContain("OK   clock synchronised (timedatectl), offset 0.001200 s")
        expect(r.stdout).not.toContain("FAIL")
    })

    it("reads an uncompressed served key too", async () => {
        served.publicKey = spkiPemOf(key.file, "uncompressed")
        expect((await check()).status).toBe(0)
    })

    it("exits 2 when the notary does not answer or is unhealthy", async () => {
        const down = await check({ NOTARY_URL: "http://127.0.0.1:1" })
        expect(down.status).toBe(2)
        expect(down.stdout).toContain("FAIL unreachable")
        // The clock is still reported
        expect(down.stdout).toContain("OK   clock")
        served.health = 503
        expect((await check()).status).toBe(2)
    })

    it("exits 3 when the notary serves another key, the stock random key after a lost key file", async () => {
        const other = makeKey(dir, "other.key")
        served.publicKey = spkiPemOf(other.file, "compressed")
        const r = await check()
        expect(r.status).toBe(3)
        expect(r.stdout).toContain(`served ${other.pub}`)
        expect(r.stdout).toContain(`pinned ${key.pub}`)
    })

    it("exits 3 when /info carries no secp256k1 key", async () => {
        served.publicKey = spkiPemOf(makeKey(dir, "p256.key", "prime256v1").file, "compressed")
        expect((await check()).status).toBe(3)
        served.publicKey = null
        expect((await check()).status).toBe(3)
    })

    it("exits 4 on an unsynchronised or drifting clock", async () => {
        expect((await check({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "no") })).status).toBe(4)
        const drift = await check({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: chronycStub(dir, "Normal", 31) })
        expect(drift.status).toBe(4)
        expect(drift.stdout).toContain("FAIL clock")
        expect((await check({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: ABSENT })).status).toBe(4)
    })

    it("reports every failure and exits with the first", async () => {
        served.publicKey = spkiPemOf(makeKey(dir, "other.key").file, "compressed")
        const r = await check({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "no") })
        expect(r.status).toBe(3)
        expect(r.stdout).toContain("FAIL key")
        expect(r.stdout).toContain("FAIL clock")
    })

    it("exits 1 on a bad configuration", async () => {
        expect((await check({ NOTARY_EXPECTED_PUBKEY: "FILL: primary" })).status).toBe(1)
        // The alert threshold must sit below the fork's futureSkewSec
        expect((await check({ NOTARY_MAX_CLOCK_OFFSET_SEC: "60", NOTARY_FUTURE_SKEW_SEC: "60" })).status).toBe(1)
    })
})
