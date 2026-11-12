import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { getSharedState } from "src/utilities/sharedState"
import { type IdentityProver, startIdentityProver } from "./launch-go-no-go"

// A stand-in validator endpoint: records each hello and refuses it, so the
// test sees what the checker sent without needing a real node
const GENESIS_A = "a".repeat(64)
const GENESIS_B = "b".repeat(64)
const IDENTITY = "0x" + "1".padStart(64, "0")

describe("go/no-go identity prover", () => {
    let server: ReturnType<typeof Bun.serve>
    let url: string
    let prover: IdentityProver
    const hellos: { genesisHash: unknown; signed: boolean }[] = []

    beforeAll(async () => {
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = (await req.json()) as any
                if (body?.method === "hello_peer") {
                    hellos.push({
                        genesisHash: body.params?.[0]?.genesisHash,
                        signed: (req.headers.get("signature") ?? "").length > 0,
                    })
                }
                return Response.json({ result: 400, response: "refused by the test endpoint", require_reply: false, extra: null })
            },
        })
        url = `http://127.0.0.1:${server.port}`
        prover = await startIdentityProver(5000)
    })

    afterAll(async () => {
        await prover.stop()
        server.stop(true)
    })

    it("sends a signed hello bound to the genesis the validator reports", async () => {
        // The checker is not a node: it has no genesis of its own
        expect(getSharedState.genesisBlockHash).toBeNull()
        hellos.length = 0
        const out = await prover.prove(IDENTITY, url, GENESIS_A)
        expect(hellos).toEqual([{ genesisHash: GENESIS_A, signed: true }])
        expect(out.proof).toBe("failed")
        expect(out.detail).toContain("hello_peer 400")
        expect(getSharedState.genesisBlockHash).toBeNull()
    })

    it("keeps each parallel probe on its own genesis", async () => {
        hellos.length = 0
        await Promise.all([
            prover.prove(IDENTITY, url, GENESIS_A),
            prover.prove(IDENTITY, url, GENESIS_B),
            prover.prove(IDENTITY, url, GENESIS_A),
        ])
        expect(hellos.map(h => h.genesisHash)).toEqual([GENESIS_A, GENESIS_B, GENESIS_A])
        expect(hellos.every(h => h.signed)).toBe(true)
    })

    it("cannot prove an identity without a genesis hash", async () => {
        hellos.length = 0
        const out = await prover.prove(IDENTITY, url, null)
        expect(hellos).toHaveLength(0)
        expect(out.proof).toBe("failed")
        expect(out.detail).toContain("Genesis hash not known yet")
    })
})
