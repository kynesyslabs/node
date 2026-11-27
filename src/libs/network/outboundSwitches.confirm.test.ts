/**
 * With XM, DemosWork or web2 switched off, RPC confirm refuses the tx before a
 * fee is quoted, instead of letting the client sign one the broadcast will
 * refuse. Node-local: nothing here touches what peers validate.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { Config } from "src/config"
import { txFeatureDisabledMessage } from "./outboundSwitches"

const SWITCHES = ["XM_ENABLED", "DEMOSWORK_ENABLED", "WEB2_ENABLED"] as const

function set(env: Partial<Record<(typeof SWITCHES)[number], string>>) {
    for (const [k, v] of Object.entries(env)) process.env[k] = v
    Config.resetInstance()
}

afterEach(() => {
    for (const s of SWITCHES) delete process.env[s]
    Config.resetInstance()
})

const work = (...contexts: string[]) => ({
    steps: Object.fromEntries(contexts.map((c, i) => [`s${i}`, { context: c }])),
})

describe("txFeatureDisabledMessage", () => {
    it("lets everything through with the switches on", () => {
        for (const type of ["crosschainOperation", "demoswork", "web2Request", "native"]) {
            expect(txFeatureDisabledMessage(type, work("xm", "web2"))).toBeNull()
        }
    })

    it("refuses each tx type whose switch is off", () => {
        set({ XM_ENABLED: "false" })
        expect(txFeatureDisabledMessage("crosschainOperation", {})).toContain("XM_ENABLED=false")
        set({ XM_ENABLED: "true", DEMOSWORK_ENABLED: "false" })
        expect(txFeatureDisabledMessage("demoswork", work())).toContain("DEMOSWORK_ENABLED=false")
        set({ DEMOSWORK_ENABLED: "true", WEB2_ENABLED: "false" })
        expect(txFeatureDisabledMessage("web2Request", {})).toContain("WEB2_ENABLED=false")
    })

    it("refuses a DemosWork script with a step of a switched-off kind", () => {
        set({ XM_ENABLED: "false" })
        expect(txFeatureDisabledMessage("demoswork", work("native", "xm"))).toContain("XM_ENABLED=false")
        expect(txFeatureDisabledMessage("demoswork", work("native", "web2"))).toBeNull()
        set({ XM_ENABLED: "true", WEB2_ENABLED: "false" })
        expect(txFeatureDisabledMessage("demoswork", work("web2"))).toContain("WEB2_ENABLED=false")
    })

    it("ignores other types and malformed scripts", () => {
        set({ XM_ENABLED: "false", DEMOSWORK_ENABLED: "true" })
        expect(txFeatureDisabledMessage("native", {})).toBeNull()
        expect(txFeatureDisabledMessage("toString", {})).toBeNull()
        expect(txFeatureDisabledMessage(undefined, null)).toBeNull()
        expect(txFeatureDisabledMessage("demoswork", null)).toBeNull()
        expect(txFeatureDisabledMessage("demoswork", { steps: "x" })).toBeNull()
    })
})
