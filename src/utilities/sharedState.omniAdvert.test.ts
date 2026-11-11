/**
 * A verified Omni advert can arrive before the Omni adapter exists: an
 * inbound hello triggers a hello back while the Omni server is starting.
 * The advert must still apply once the adapter is up.
 */

import { describe, expect, it } from "bun:test"
import SharedState from "@/utilities/sharedState"

const PEER = "0x" + "ab".repeat(32)
const URL_A = "http://10.0.0.9:53550"

describe("a verified Omni advert before the adapter is up", () => {
    it("is applied when the adapter starts", () => {
        const state = new SharedState()
        state.markPeerOmniCapable(PEER, URL_A, 63551)
        state.initOmniProtocol("OMNI_PREFERRED")
        expect(state.omniAdapter?.shouldUseOmni(PEER, URL_A)).toBe(true)
    })

    it("is dropped by a later verified reply without one", () => {
        const state = new SharedState()
        state.markPeerOmniCapable(PEER, URL_A, 63551)
        state.forgetPeerOmni(PEER)
        state.initOmniProtocol("OMNI_PREFERRED")
        expect(state.omniAdapter?.shouldUseOmni(PEER, URL_A)).toBe(false)
    })
})
