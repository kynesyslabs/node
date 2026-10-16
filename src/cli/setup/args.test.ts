import { describe, expect, it } from "bun:test"
import { parseSetupArgs, UsageError } from "./args"
import {
    normalizeHex,
    parseBool,
    validateHex,
    validateIvHex,
    validateKeyHex,
    validatePort,
    validateRpcList,
    validateUid,
} from "./validate"

describe("validators", () => {
    it("accepts the subnet ids the node loader accepts and rejects the rest", () => {
        expect(validateUid("dev_l2ps-001").ok).toBe(true)
        expect(validateUid("has.dot").ok).toBe(false)
        expect(validateUid("../escape").ok).toBe(false)
        expect(validateUid("").ok).toBe(false)
        // The loader has no length limit, so neither does the setup.
        expect(validateUid("a".repeat(100)).ok).toBe(true)
    })

    it("normalises hex and enforces byte lengths", () => {
        expect(validateKeyHex(" 0x" + "AB".repeat(32) + "\n").value).toBe("ab".repeat(32))
        expect(validateKeyHex("ab".repeat(31)).ok).toBe(false)
        expect(validateKeyHex("zz".repeat(32)).error).toContain("non-hex")
        // Same normalisation as the loader: a 0x/0X prefix and any inner whitespace go.
        expect(validateKeyHex("0X" + "ab".repeat(16) + " \n\t" + "ab".repeat(16)).value).toBe("ab".repeat(32))
        expect(normalizeHex("0xAB cd\n")).toBe("abcd")
        expect(validateHex("abc", "X", [2]).error).toContain("even")
        expect(validateIvHex("cd".repeat(12)).ok).toBe(true)
        expect(validateIvHex("cd".repeat(16)).ok).toBe(true)
        expect(validateIvHex("cd".repeat(8)).ok).toBe(false)
    })

    it("validates RPC lists", () => {
        expect(validateRpcList("http://a:1, https://b:2/").value).toEqual(["http://a:1", "https://b:2"])
        expect(validateRpcList(["http://a:1", "http://a:1"]).value).toEqual(["http://a:1"])
        expect(validateRpcList("ftp://a").ok).toBe(false)
        expect(validateRpcList("nonsense").ok).toBe(false)
        expect(validateRpcList("  ").ok).toBe(false)
    })

    it("validates ports and booleans", () => {
        expect(validatePort("3006").value).toBe(3006)
        expect(validatePort("0").ok).toBe(false)
        expect(validatePort("70000").ok).toBe(false)
        expect(validatePort("80a").ok).toBe(false)
        expect(parseBool("YES")).toBe(true)
        expect(parseBool("off")).toBe(false)
        expect(parseBool("maybe")).toBeUndefined()
    })
})

describe("parseSetupArgs", () => {
    it("reads flags, repeated list flags and --no- booleans", () => {
        const o = parseSetupArgs(
            ["--yes", "--l2ps-uid", "demo_1", "--l2ps-rpc", "http://a:1", "--l2ps-rpc=http://b:2",
                "--no-messaging", "--zk", "--history-retention-days", "30"],
            {},
        )
        expect(o.yes).toBe(true)
        expect(o.uid).toBe("demo_1")
        expect(o.rpcs).toEqual(["http://a:1", "http://b:2"])
        expect(o.messaging).toBe(false)
        expect(o.zk).toBe(true)
        expect(o.retentionDays).toBe(30)
        expect(o.envFile).toBe(".env")
    })

    it("falls back to DEMOS_SETUP_* variables and lets flags win", () => {
        const env = {
            DEMOS_SETUP_L2PS_UID: "from_env",
            DEMOS_SETUP_MESSAGING: "true",
            DEMOS_SETUP_MESSAGING_PORT: "4000",
            DEMOS_SETUP_YES: "1",
            DEMOS_SETUP_L2PS_KEY: "ab".repeat(32),
        }
        const o = parseSetupArgs([], env)
        expect(o.uid).toBe("from_env")
        expect(o.messaging).toBe(true)
        expect(o.messagingPort).toBe(4000)
        expect(o.yes).toBe(true)
        expect(o.keyHex).toBe("ab".repeat(32))
        expect(parseSetupArgs(["--l2ps-uid", "flag_wins"], env).uid).toBe("flag_wins")
    })

    it("takes a ptau mirror from a flag or the environment and validates it", () => {
        expect(parseSetupArgs(["--ptau-url", "https://mirror.example/ptau/"], {}).ptauUrl).toBe("https://mirror.example/ptau")
        expect(parseSetupArgs([], { DEMOS_SETUP_PTAU_URL: "https://m.example" }).ptauUrl).toBe("https://m.example")
        expect(() => parseSetupArgs(["--ptau-url", "mirror"], {})).toThrow(UsageError)
    })

    it("does not print a stray argument back, since it may be a secret", () => {
        const stray = "typed-by-mistake-value"
        let message = ""
        try {
            parseSetupArgs(["--yes", stray], {})
        } catch (e) {
            message = e instanceof UsageError ? e.message : String(e)
        }
        expect(message).toContain("Unexpected argument at position 2")
        expect(message).not.toContain(stray)
    })

    it("rejects bad values with a usage error", () => {
        expect(() => parseSetupArgs(["--l2ps-uid", "bad uid"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--messaging-port", "99999"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--only", "everything"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--l2ps-role", "boss"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--nope"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--l2ps-uid"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs(["--only", "zk", "--l2ps-uid", "x"], {})).toThrow(UsageError)
        expect(() => parseSetupArgs([], { DEMOS_SETUP_ZK: "maybe" })).toThrow(UsageError)
    })
})
