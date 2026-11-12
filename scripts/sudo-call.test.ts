import { describe, expect, it } from "bun:test"
import { cleartextRefusal } from "./sudo-call"

describe("sudo-call transport", () => {
    it("refuses plain http to a remote node, where an observer reads the call and its answer", () => {
        expect(cleartextRefusal("http://203.0.113.4:53550", false)).toContain("https")
        expect(cleartextRefusal("http://node2.example:53550", false)).toContain("https")
    })

    it("allows https, the local node, and plain http when the operator says so", () => {
        expect(cleartextRefusal("https://node2.example", false)).toBeNull()
        expect(cleartextRefusal("http://localhost:53550", false)).toBeNull()
        expect(cleartextRefusal("http://127.0.0.1:53550", false)).toBeNull()
        expect(cleartextRefusal("http://[::1]:53550", false)).toBeNull()
        expect(cleartextRefusal("http://203.0.113.4:53550", true)).toBeNull()
    })
})
