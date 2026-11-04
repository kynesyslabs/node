/**
 * Every version report (/version, /info, /health, the Omni version call and
 * getNetworkInfo) must name the release in package.json; the release workflow
 * refuses a tag that differs from it, so a stale constant would make a node
 * misreport which release it runs.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NODE_VERSION } from "./nodeVersion"
import { getSharedState } from "./sharedState"
import { handleGetNodeVersion } from "@/libs/omniprotocol/protocol/handlers/control"
import { decodeStringResponse } from "@/libs/omniprotocol/serialization/control"

const packageVersion: string = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
).version

describe("reported node version", () => {
    it("comes from package.json", () => {
        expect(packageVersion).toBeTruthy()
        expect(NODE_VERSION.version).toBe(packageVersion)
    })

    it("is what the HTTP version, info and health reports read", () => {
        expect(getSharedState.version).toBe(packageVersion)
    })

    it("is what the Omni version call answers", async () => {
        const reply = decodeStringResponse(await handleGetNodeVersion({} as any))
        expect(reply).toEqual({ status: 200, value: packageVersion })
    })
})
