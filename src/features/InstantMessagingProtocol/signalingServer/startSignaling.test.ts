import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {} },
}))

const { startSignaling } = await import("./startSignaling")
const { DEFAULT_CONFIG } = await import("src/config/defaults")

describe("startSignaling", () => {
    it("is on by default, as deployments that publish its port expect", () => {
        expect(DEFAULT_CONFIG.core.signalingEnabled).toBe(true)
    })

    it("starts the server on the given port", () => {
        const server = {} as never
        const ports: number[] = []
        const res = startSignaling(true, 3005, port => (ports.push(port), server))
        expect(res).toEqual({ status: "ready", server })
        expect(ports).toEqual([3005])
    })

    it("does not start it when disabled", () => {
        let created = false
        const res = startSignaling(false, 3005, () => ((created = true), {} as never))
        expect(res.status).toBe("skipped")
        expect(created).toBe(false)
    })

    it("returns a start failure instead of throwing", () => {
        const res = startSignaling(true, 3005, () => {
            throw new Error("EADDRINUSE")
        })
        expect(res.status).toBe("failed")
        expect((res as { error: Error }).error.message).toBe("EADDRINUSE")
    })
})
