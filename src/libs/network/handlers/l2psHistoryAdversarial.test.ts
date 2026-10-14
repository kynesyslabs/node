/**
 * Hostile input against the authenticated history read.
 *
 * The signature check is the only thing between a request and a member's
 * history, so these try to make two different requests share one signed
 * string, to present a valid signature for something it was not made for, and
 * to push a request into a failure path that answers more than it should.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import forge from "node-forge"

const getAccountTransactions = jest.fn(async (..._args: unknown[]) => [] as any[])

jest.mock("../../blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { getByUID: jest.fn() },
    L2PS_STATUS: {},
}))

jest.mock("../../l2ps/L2PSTransactionExecutor", () => ({
    __esModule: true,
    default: { getAccountTransactions },
}))

jest.mock("@/libs/l2ps/historyPayload", () => ({
    resolveHistoryEntry: jest.fn(async () => ({ message: null, content: null })),
    subnetDecryptor: jest.fn(async () => undefined),
}))

const NODE_KEY = "0x" + "ab".repeat(32)

const sharedState: Record<string, unknown> = {}
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))

const l2psConfig = { historyRequireV2: false }
jest.mock("src/config", () => ({
    Config: { getInstance: () => ({ l2ps: l2psConfig }) },
}))

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

const { l2psHandlers } = await import("./l2psHandlers")
const { historyAuthMessageV2 } = await import("@/libs/l2ps/historyAuth")

const keypair = forge.pki.ed25519.generateKeyPair()
const other = forge.pki.ed25519.generateKeyPair()
const hexOf = (key: Uint8Array) => Buffer.from(key).toString("hex")
const address = "0x" + hexOf(keypair.publicKey)
const otherAddress = "0x" + hexOf(other.publicKey)
const UID = "subnet-1"

const signWith = (privateKey: Uint8Array, message: string) =>
    "0x" + hexOf(forge.pki.ed25519.sign({ message, encoding: "utf8", privateKey }))
const sign = (message: string) => signWith(keypair.privateKey, message)

const v2 = (host: string, ts: string | number, limit = 100, offset = 0, since = 0, uid = UID, addr = address) =>
    `getL2PSHistory/2:${uid}:${addr}:${ts}:${host}:${limit}:${offset}:${since}`

const call = async (data: Record<string, unknown>) => {
    const response: any = {}
    await l2psHandlers.getL2PSAccountTransactions(
        { l2psUid: UID, address, ...data } as any,
        response,
    )
    return response
}

const signedV2 = (ts: string | number, extra: Record<string, unknown> = {}, message?: string) => ({
    signatureVersion: 2,
    host: NODE_KEY,
    timestamp: ts,
    signature: sign(message ?? v2(NODE_KEY, ts)),
    ...extra,
})

const REAL_NOW = Date.now
const NOW = 1_800_000_000_000

beforeEach(() => {
    getAccountTransactions.mockReset()
    getAccountTransactions.mockResolvedValue([])
    sharedState.publicKeyHex = NODE_KEY
    sharedState.exposedUrl = "https://node-a.example.org"
    l2psConfig.historyRequireV2 = false
    Date.now = () => NOW
})

afterEach(() => {
    Date.now = REAL_NOW
})

describe("replay of one valid version 2 signature", () => {
    const ts = String(NOW)

    it.each([
        ["subnet", { l2psUid: "subnet-2" }],
        ["limit", { limit: 99 }],
        ["offset", { offset: 1 }],
        ["since", { since: 1 }],
        ["timestamp", { timestamp: String(NOW + 1) }],
        ["address, upper-cased hex", { address: "0x" + address.slice(2).toUpperCase() }],
        ["address, without the 0x prefix", { address: address.slice(2) }],
        ["host, other casing of the advertised name", { host: "NODE-A.example.org" }],
    ])("is refused when the %s is changed", async (_name, change) => {
        const response = await call(signedV2(ts, change))

        expect([401, 403]).toContain(response.result)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("is accepted once, unchanged, so the cases above fail for the right reason", async () => {
        const response = await call(signedV2(ts))
        expect(response.result).toBe(200)
    })

    it("does not let a signature for one address read another's history", async () => {
        const forged = signWith(other.privateKey, v2(NODE_KEY, ts))
        const response = await call(signedV2(ts, { signature: forged }))

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("does not let a member who signs for their own key read the history of the address they name", async () => {
        const message = v2(NODE_KEY, ts, 100, 0, 0, UID, address)
        const response = await call(
            signedV2(ts, { address: otherAddress }, message),
        )

        expect(response.result).toBe(403)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })
})

describe("one signed string for two requests", () => {
    it.each([
        ["subnet", { l2psUid: "a:b" }],
        ["address", { address: address + ":x" }],
        ["timestamp", { timestamp: String(NOW) + ":5" }],
        ["timestamp with a space", { timestamp: String(NOW) + " " }],
        ["timestamp with a sign", { timestamp: "+" + String(NOW) }],
    ])("a version 2 request is refused when the %s carries a delimiter or non-digit", async (_n, change) => {
        const response = await call(signedV2(String(NOW), change))

        expect([400, 403]).toContain(response.result)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("names the same string for two different tuples never, over a hostile alphabet", () => {
        // uid, address and timestamp cannot hold ":" once the handler has run,
        // and limit/offset/since are integers, so the tail is parseable from
        // the right. A collision would need the host to absorb a field.
        const hosts = ["h", "h:1", "h:1:2", "h:1:2:3", "1:2", ":", "", "a:b:c:d:e"]
        const uids = ["u", "u1", "1"]
        const nums = [0, 1, 10, 100]
        const seen = new Map<string, string>()
        for (const uid of uids)
            for (const host of hosts)
                for (const limit of nums)
                    for (const offset of nums)
                        for (const since of nums) {
                            const msg = historyAuthMessageV2(uid, "addr", "123", host, { limit, offset, since })
                            const tuple = JSON.stringify([uid, host, limit, offset, since])
                            const prior = seen.get(msg)
                            if (prior !== undefined) expect(prior).toBe(tuple)
                            seen.set(msg, tuple)
                        }
        expect(seen.size).toBe(uids.length * hosts.length * nums.length ** 3)
    })

    it("a signature for the unversioned message never verifies as version 2, whatever the subnet name", async () => {
        const ts = String(NOW)
        for (const uid of ["/2", "/2:x", "x"]) {
            if (uid.includes(":")) continue
            const legacy = `getL2PSHistory:${uid}:${address}:${ts}`
            const response = await call(signedV2(ts, { l2psUid: uid }, legacy))
            expect(response.result).toBe(403)
        }
    })
})

describe("timestamp window", () => {
    const FIVE_MIN = 5 * 60 * 1000

    it.each([
        ["exactly five minutes old", NOW - FIVE_MIN, 200],
        ["one millisecond beyond five minutes", NOW - FIVE_MIN - 1, 401],
        ["exactly one minute ahead", NOW + 60_000, 200],
        ["one millisecond beyond a minute ahead", NOW + 60_001, 401],
        ["a day ahead", NOW + 86_400_000, 401],
        ["zero", 0, 401],
    ])("version 2: %s", async (_n, t, status) => {
        const response = await call(signedV2(String(t)))
        expect(response.result).toBe(status)
    })

    it("a numeric timestamp and its string form sign the same message", async () => {
        const asNumber = await call(signedV2(NOW, {}, v2(NODE_KEY, String(NOW))))
        expect(asNumber.result).toBe(200)
    })

    it.each([
        ["negative", "-5"],
        ["float", "1799999999999.5"],
        ["exponent", "1.8e12"],
        ["hex", "0x1a2b"],
        ["NaN", "NaN"],
        ["Infinity", "Infinity"],
        ["empty", ""],
    ])("refuses a %s timestamp", async (_n, t) => {
        const response = await call(signedV2(t, {}, v2(NODE_KEY, t)))
        expect([400, 401]).toContain(response.result)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it.each([
        ["an object", { valueOf: () => String(NOW) }],
        ["an array", [String(NOW)]],
        ["true", true],
        ["null", null],
    ])("refuses %s as the timestamp without throwing", async (_n, t) => {
        const response = await call({ ...signedV2(String(NOW)), timestamp: t })
        expect(response.result).toBeGreaterThanOrEqual(400)
        expect(response.result).toBeLessThan(500)
    })

    it("a leading-zero timestamp is a different string and needs its own signature", async () => {
        const padded = "0" + String(NOW)
        const replay = await call(signedV2(padded, {}, v2(NODE_KEY, String(NOW))))
        expect(replay.result).toBe(403)
        const own = await call(signedV2(padded, {}, v2(NODE_KEY, padded)))
        expect(own.result).toBe(200)
    })
})

describe("signatureVersion", () => {
    const ts = String(NOW)

    it.each([[2], ["2"]])("accepts %j", async version => {
        const response = await call(signedV2(ts, { signatureVersion: version }))
        expect(response.result).toBe(200)
    })

    it.each([
        ["02"],
        ["2.0"],
        [" 2"],
        [2.5],
        [1],
        ["1"],
        [3],
        [0],
        [""],
        [true],
        [false],
        [null],
        [[2]],
        [{ toString: () => "2" }],
        [NaN],
    ])("refuses %j with a 400 and reads nothing", async version => {
        const response = await call(signedV2(ts, { signatureVersion: version }))
        expect(response.result).toBe(400)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })

    it("with the version missing takes the legacy path, which a node that requires version 2 refuses", async () => {
        const legacy = `getL2PSHistory:${UID}:${address}:${ts}`
        const data = { timestamp: ts, signature: sign(legacy) }

        expect((await call(data)).result).toBe(200)

        l2psConfig.historyRequireV2 = true
        const refused = await call(data)
        expect(refused.result).toBe(401)
        expect(getAccountTransactions).toHaveBeenCalledTimes(1)
    })

    it("an explicit undefined version is the same as a missing one", async () => {
        const legacy = `getL2PSHistory:${UID}:${address}:${ts}`
        l2psConfig.historyRequireV2 = true
        const response = await call({ timestamp: ts, signature: sign(legacy), signatureVersion: undefined })
        expect(response.result).toBe(401)
    })

    it("a version 2 signature does not unlock the unversioned path of a node that requires version 2", async () => {
        l2psConfig.historyRequireV2 = true
        const response = await call({ timestamp: ts, signature: sign(v2(NODE_KEY, ts)) })
        expect(response.result).toBe(401)
        expect(getAccountTransactions).not.toHaveBeenCalled()
    })
})

describe("page values, version 2", () => {
    const ts = String(NOW)
    const run = (page: Record<string, unknown>, signed: [number, number, number]) =>
        call(signedV2(ts, page, v2(NODE_KEY, ts, ...signed)))

    it.each([
        ["limit 0 clamps to 1", { limit: 0 }, [1, 0, 0], 2],
        ["limit -1 clamps to 1", { limit: -1 }, [1, 0, 0], 2],
        ["limit 1e9 clamps to 1000", { limit: 1e9 }, [1000, 0, 0], 1001],
        ["limit null takes the default", { limit: null }, [100, 0, 0], 101],
        ["limit undefined takes the default", { limit: undefined }, [100, 0, 0], 101],
        ["limit as a padded string", { limit: " 7 " }, [7, 0, 0], 8],
        ["limit 5.0 is the integer 5", { limit: "5.0" }, [5, 0, 0], 6],
    ])("%s", async (_n, page, signed, asked) => {
        const response = await run(page, signed as [number, number, number])
        expect(response.result).toBe(200)
        expect(getAccountTransactions.mock.calls[0][2]).toBe(asked)
    })

    it.each([
        ["offset -5 clamps to 0", { offset: -5 }, [100, 0, 0], 0],
        ["since -5 clamps to 0", { since: -5 }, [100, 0, 0], 0],
        ["offset -0 is 0", { offset: -0 }, [100, 0, 0], 0],
    ])("%s", async (_n, page, signed, offset) => {
        const response = await run(page, signed as [number, number, number])
        expect(response.result).toBe(200)
        expect(getAccountTransactions.mock.calls[0][3]).toBe(offset)
        expect(getAccountTransactions.mock.calls[0][4]).toBe(0)
    })

    it.each([
        ["100abc"],
        ["abc"],
        [""],
        ["Infinity"],
        ["-Infinity"],
        ["NaN"],
        ["1e3"],
        ["0x10"],
        [{}],
        [[]],
        [[5]],
        [true],
        [Infinity],
        [NaN],
        [1e308],
        [2 ** 53],
        ["9007199254740993"],
        [{ valueOf: () => 5 }],
    ])("a %j limit, offset or since is a 400 and never a default the caller did not sign", async value => {
        // A number past the safe range as a limit is clamped to the maximum and
        // that value is what is signed; offset and since have no ceiling.
        const clampedLimit = (typeof value === "number" || typeof value === "string") && Number(value) > 1000
        for (const key of clampedLimit ? ["offset", "since"] : ["limit", "offset", "since"]) {
            getAccountTransactions.mockClear()
            const response = await call(signedV2(ts, { [key]: value }))
            expect(response.result).toBe(400)
            expect(getAccountTransactions).not.toHaveBeenCalled()
        }
    })

    it("a 1e308 since is refused, not passed on to the table read", async () => {
        const response = await call(signedV2(ts, { since: "1" + "0".repeat(308) }))
        expect(response.result).toBe(400)
    })
})

describe("no 5xx from a malformed request", () => {
    const ts = String(NOW)

    it.each([
        ["a numeric signature", { signature: 12345 }],
        ["an object signature", { signature: { startsWith: () => true } }],
        ["an array signature", { signature: ["0x00"] }],
        ["a numeric address", { address: 12345 }],
        ["an object address", { address: {} }],
        ["a numeric host", { host: 5 }],
        ["an object host", { host: { toLowerCase: () => NODE_KEY } }],
        ["an odd-length hex signature", { signature: "0xabc" }],
        ["a non-hex signature", { signature: "0x" + "zz".repeat(64) }],
        ["an empty signature after the prefix", { signature: "0x" }],
        ["a doubled prefix", { signature: "0x0x" + "00".repeat(64) }],
        ["an oversized signature", { signature: "00".repeat(100_000) }],
        ["an address that is not a key", { address: "0xnothex" }],
        ["a 33-byte address", { address: "0x" + "ab".repeat(33) }],
    ])("%s is answered with a client error, not an internal one", async (_n, change) => {
        for (const version of [undefined, 2]) {
            const data: Record<string, unknown> = signedV2(ts, change)
            if (version === undefined) delete data.signatureVersion
            const response = await call(data)
            expect(response.result).toBeGreaterThanOrEqual(400)
            expect(response.result).toBeLessThan(500)
            expect(JSON.stringify(response)).not.toContain("is not a function")
        }
    })
})

describe("unversioned request, page values the node applies", () => {
    const ts = String(NOW)
    const legacy = () => ({ timestamp: ts, signature: sign(`getL2PSHistory:${UID}:${address}:${ts}`) })

    it("hands the table whole numbers inside the safe range for a hostile offset and since", async () => {
        const response = await call({ ...legacy(), offset: 1e308, since: 1e308, limit: 2.5 })
        expect(response.result).toBe(200)

        const [, , limit, offset, since] = getAccountTransactions.mock.calls[0] as number[]
        for (const value of [limit, offset, since]) {
            expect(Number.isSafeInteger(value)).toBe(true)
        }
    })

    it("rounds a fractional offset down so the row it names is not skipped", async () => {
        await call({ ...legacy(), offset: "1.5" })
        expect(getAccountTransactions.mock.calls[0][3]).toBe(1)
    })
})

describe("what a failed read tells the caller", () => {
    const ts = String(NOW)

    it("does not echo a table error", async () => {
        getAccountTransactions.mockRejectedValue(
            new Error('password authentication failed for user "node" at postgres://node:s3cret@db:5432/demos'),
        )
        const response = await call(signedV2(ts))

        expect(response.result).toBe(500)
        expect(JSON.stringify(response)).not.toContain("s3cret")
        expect(JSON.stringify(response)).not.toContain("postgres://")
    })
})

describe("an advertised URL that only spells loopback differently is not an identity", () => {
    it.each([["localhost."], ["foo.localhost"], ["[::]"], ["[0:0:0:0:0:0:0:1]"], ["127.1"]])(
        "%s",
        async spelling => {
            sharedState.exposedUrl = `http://${spelling}:53550`
            const host = new URL(sharedState.exposedUrl as string).host
            const ts = String(NOW)
            const response = await call(signedV2(ts, { host }, v2(host, ts)))

            expect(response.result).toBe(403)
            expect(getAccountTransactions).not.toHaveBeenCalled()
        },
    )
})
