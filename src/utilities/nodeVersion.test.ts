/**
 * Every version report (/version, /info, /health, the Omni version call and
 * getNetworkInfo) must name the release in package.json; the release workflow
 * refuses a tag that differs from it, so a stale constant would make a node
 * misreport which release it runs.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NODE_VERSION } from "./nodeVersion"
import { getSharedState } from "./sharedState"
import { handleGetNodeVersion } from "@/libs/omniprotocol/protocol/handlers/control"
import { decodeStringResponse } from "@/libs/omniprotocol/serialization/control"
import { BunServer } from "@/libs/network/bunServer"
import Mempool from "@/libs/blockchain/mempool"
import { serverRpcBun } from "@/libs/network/server_rpc"
import { forkHandlers } from "@/libs/network/handlers/forkHandlers"

const packageVersion: string = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
).version

describe("reported node version", () => {
    it("comes from package.json", () => {
        expect(packageVersion).toBeTruthy()
        expect(NODE_VERSION.version).toBe(packageVersion)
    })

    it("is what the Omni version call answers", async () => {
        const reply = decodeStringResponse(await handleGetNodeVersion({} as any))
        expect(reply).toEqual({ status: 200, value: packageVersion })
    })

    it("is what getNetworkInfo answers", async () => {
        const loaded = getSharedState.forkConfigLoaded
        getSharedState.forkConfigLoaded = true
        try {
            const res: any = await forkHandlers.getNetworkInfo({}, {
                result: 200,
                response: null,
                require_reply: false,
                extra: null,
            })
            expect(res.result).toBe(200)
            expect(res.response.nodeVersion.version).toBe(packageVersion)
        } finally {
            getSharedState.forkConfigLoaded = loaded
        }
    })
})

describe("reported node version over HTTP", () => {
    let server: BunServer
    const spies: { mockRestore(): void }[] = []
    // The rate limiter lets a loopback caller through.
    const socket = { requestIP: () => ({ address: "127.0.0.1" }) }

    beforeAll(async () => {
        // The real routes are registered, but nothing listens and the mempool
        // count /health makes does not reach a database.
        spies.push(
            spyOn(BunServer.prototype, "start").mockImplementation(function (
                this: BunServer,
            ) {
                server = this
                return {} as any
            }),
            spyOn(Mempool, "count").mockResolvedValue(0),
        )
        await serverRpcBun()
    })

    afterAll(() => spies.forEach(s => s.mockRestore()))

    async function get(path: string): Promise<{ status: number; body: any }> {
        const res: Response = await (server as any).handleRequest(
            new Request(`http://127.0.0.1${path}`),
            socket,
        )
        return { status: res.status, body: await res.json() }
    }

    it("/version names it", async () => {
        const { status, body } = await get("/version")
        expect(status).toBe(200)
        expect(body.version).toBe(packageVersion)
    })

    it("/info names it", async () => {
        const { status, body } = await get("/info")
        expect(status).toBe(200)
        expect(body.version).toBe(packageVersion)
    })

    it("/health names it", async () => {
        const { body } = await get("/health")
        expect(body.version).toBe(packageVersion)
    })
})
