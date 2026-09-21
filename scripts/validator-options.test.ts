import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { resolveStakeConnectionUrl } from "./validator-options"

describe("validator stake options", () => {
    test("the validator command resolves the advertised URL independently", () => {
        const source = readFileSync(
            new URL("./validator.ts", import.meta.url),
            "utf8",
        )
        expect(source).toContain("resolveStakeConnectionUrl(flags, process.env)")
        expect(source).not.toContain("const connectionUrl = rpc")
    })

    test("operator guides use the current non-destructive command forms", () => {
        const staking = readFileSync(
            new URL("../documentation/staking.md", import.meta.url),
            "utf8",
        )
        const fixnet = readFileSync(
            new URL("../documentation/join-fixnet.md", import.meta.url),
            "utf8",
        )
        expect(staking).not.toContain("git restore .")
        expect(fixnet).not.toContain("-t true")
        expect(fixnet).toContain("-t\n")
    })

    test("keeps the advertised connection URL separate from the transaction RPC", () => {
        const flags = {
            rpc: "https://rpc.example",
            "connection-url": "http://validator.example:53550",
        }

        expect(resolveStakeConnectionUrl(flags, {})).toBe(
            "http://validator.example:53550",
        )
        expect(resolveStakeConnectionUrl(flags, {})).not.toBe(flags.rpc)
    })

    test("never falls back to advertising the transaction RPC", () => {
        expect(() =>
            resolveStakeConnectionUrl({ rpc: "https://rpc.example" }, {}),
        ).toThrow("stake requires --connection-url")
    })

    test("accepts the independently configured EXPOSED_URL", () => {
        expect(
            resolveStakeConnectionUrl(
                { rpc: "https://rpc.example" },
                { EXPOSED_URL: "http://validator.example:53550" },
            ),
        ).toBe("http://validator.example:53550")
    })

    test("rejects a credential-bearing or non-root advertised URL", () => {
        expect(() =>
            resolveStakeConnectionUrl(
                { "connection-url": "https://user@validator.example" },
                {},
            ),
        ).toThrow("must contain only")
        expect(() =>
            resolveStakeConnectionUrl(
                { "connection-url": "https://validator.example/info" },
                {},
            ),
        ).toThrow("must contain only")
    })
})
