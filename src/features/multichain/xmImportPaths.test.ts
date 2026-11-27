/**
 * The XM executors and the DemosWork handlers import the SDK through its
 * published entry points. A path into node_modules/.../build is the
 * package's internal layout and breaks silently when an SDK release moves it.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = [
    "src/features/multichain",
    "src/libs/network/routines/transactions",
]

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sourceFiles(path)
        return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : []
    })
}

describe("XM and DemosWork SDK imports", () => {
    it("never import from a node_modules build path", () => {
        const offenders = ROOTS.flatMap(sourceFiles).filter(path =>
            /from\s+["']node_modules\//.test(readFileSync(path, "utf8")),
        )
        expect(offenders).toEqual([])
    })

    it("the Aptos pay handler still loads and refuses an unknown network", async () => {
        const { default: handleAptosPayRest } = await import(
            "./routines/executors/aptos_pay_rest"
        )
        const reply = await handleAptosPayRest({
            chain: "aptos",
            subchain: "nowhere",
            is_evm: false,
            rpc: "",
            task: { type: "pay", params: {}, signedPayloads: ["00"] },
        })
        expect(reply.result).toBe("error")
    })
})
