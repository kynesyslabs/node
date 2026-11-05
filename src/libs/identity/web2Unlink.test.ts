import { describe, expect, it } from "bun:test"
import { selectWeb2Unlink } from "./web2Unlink"

const NF = "Identity not found"

describe("which links one web2 unlink removes", () => {
    it("removes every link of the platform account named by userId, under any handle or id spelling", () => {
        const links = [
            { username: "alice", userId: "7" },
            { username: "bob", userId: "8" },
            { username: "alice-old", userId: 7 },
        ]
        expect(selectWeb2Unlink(links, { userId: "7" }, NF)).toEqual({
            ok: true,
            indexes: [0, 2],
            removed: links[0],
        })
        expect(selectWeb2Unlink(links, { userId: 9 }, NF)).toEqual({ ok: false, message: NF })
    })

    it("follows a username to its link's userId, and from there to every link of that account", () => {
        const links = [
            { username: "alice", userId: "7" },
            { username: "alice-old", userId: "7" },
            { username: "bob", userId: "8" },
        ]
        expect(selectWeb2Unlink(links, { username: "alice" }, NF)).toEqual({
            ok: true,
            indexes: [0, 1],
            removed: links[0],
        })
    })

    it("refuses a username that two links carry instead of removing both", () => {
        const links = [
            { username: "alice", userId: "7" },
            { username: "alice", userId: "8" },
        ]
        const r = selectWeb2Unlink(links, { username: "alice" }, NF)
        expect(r.ok).toBe(false)
        expect(selectWeb2Unlink(links, { username: "alice", userId: "8" }, NF)).toEqual({
            ok: true,
            indexes: [1],
            removed: links[1],
        })
    })

    it("removes a link stored without a userId by its username, and only that link", () => {
        const links = [
            { username: "legacy" },
            { username: "other", userId: "9" },
        ]
        expect(selectWeb2Unlink(links, { username: "legacy" }, NF)).toEqual({
            ok: true,
            indexes: [0],
            removed: links[0],
        })
        expect(selectWeb2Unlink(links, { userId: "1" }, NF)).toEqual({ ok: false, message: NF })
    })

    it("never matches a link the caller rules out", () => {
        const links = [
            { username: "alice", userId: "7", proofType: "tlsn" },
            { username: "alice-gist", userId: "7" },
        ]
        const tlsn = (l: { proofType?: string }) => l.proofType === "tlsn"
        expect(selectWeb2Unlink(links, { username: "alice" }, NF, tlsn)).toEqual({
            ok: true,
            indexes: [0],
            removed: links[0],
        })
        expect(selectWeb2Unlink(links, { username: "alice-gist" }, NF, tlsn)).toEqual({
            ok: false,
            message: NF,
        })
    })

    it("refuses a request that names nothing", () => {
        const links = [{ username: "", userId: "7" }]
        expect(selectWeb2Unlink(links, {}, NF)).toEqual({ ok: false, message: NF })
        expect(selectWeb2Unlink(links, { username: "" }, NF)).toEqual({ ok: false, message: NF })
        expect(selectWeb2Unlink(links, { username: 7 }, NF)).toEqual({ ok: false, message: NF })
    })
})
