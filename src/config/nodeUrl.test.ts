import { describe, expect, it } from "bun:test"
import { isLoopbackHost } from "./nodeUrl"

describe("isLoopbackHost", () => {
    it.each([
        "localhost",
        "LOCALHOST",
        "127.0.0.1",
        "127.0.0.2",
        "127.255.255.255",
        "0.0.0.0",
        "::1",
        "[::1]",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "[::ffff:7f00:2]",
        "::FFFF:7F01:FFFF",
    ])("treats %s as loopback", host => {
        expect(isLoopbackHost(host)).toBe(true)
    })

    it.each(["128.0.0.1", "126.255.255.255", "127.0.0", "1270.0.0.1", "node-a.example.org", "::ffff:10.0.0.1", "::ffff:7e00:1", "::ffff:a00:1"])(
        "does not treat %s as loopback",
        host => {
            expect(isLoopbackHost(host)).toBe(false)
        },
    )
})
