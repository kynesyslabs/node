import { beforeEach, describe, expect, it, jest } from "@jest/globals"

import { DEFAULT_OMNIPROTOCOL_CONFIG } from "src/libs/omniprotocol/types/config"
import PeerOmniAdapter from "src/libs/omniprotocol/integration/peerAdapter"

const createMockPeer = () => {
    return {
        identity: "mock-peer",
        call: jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        })),
        longCall: jest.fn(async () => ({
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        })),
    }
}

describe("PeerOmniAdapter", () => {
    let adapter: PeerOmniAdapter

    beforeEach(() => {
        adapter = new PeerOmniAdapter({
            config: DEFAULT_OMNIPROTOCOL_CONFIG,
        })
    })

    it("falls back to HTTP when migration mode is HTTP_ONLY", async () => {
        const peer = createMockPeer()
        const request = { method: "ping", params: [] }

        const response = await adapter.adaptCall(
            peer as any,
            request as any,
        )

        expect(response.result).toBe(200)
        expect(peer.call).toHaveBeenCalledTimes(1)
    })

    it("honors omni peer allow list in OMNI_PREFERRED mode", async () => {
        const peer = createMockPeer()

        adapter.migrationMode = "OMNI_PREFERRED"
        expect(adapter.shouldUseOmni(peer.identity)).toBe(false)

        adapter.markOmniPeer(peer.identity)
        expect(adapter.shouldUseOmni(peer.identity)).toBe(true)

        adapter.markHttpPeer(peer.identity)
        expect(adapter.shouldUseOmni(peer.identity)).toBe(false)
    })

    it("treats OMNI_ONLY mode as always-on", () => {
        adapter.migrationMode = "OMNI_ONLY"
        expect(adapter.shouldUseOmni("any-peer"))
            .toBe(true)
    })
})
