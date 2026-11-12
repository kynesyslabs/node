import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { admitSudoCall, sudoFloorPath } from "./sudoReplayFloor"

const dir = mkdtempSync(join(tmpdir(), "sudo-floor-unit-"))
let n = 0
const identity = () => join(dir, `identity-${++n}`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("sudo replay floor", () => {
    it("admits a later call, persisting its timestamp before it runs", () => {
        const id = identity()
        expect(admitSudoCall(id, 1_000)).toBeNull()
        expect(JSON.parse(readFileSync(sudoFloorPath(id), "utf8"))).toEqual({ acceptedUpTo: 1_000 })
        expect(admitSudoCall(id, 1_000)).toContain("not after the last one")
        expect(admitSudoCall(id, 999)).toContain("not after the last one")
        expect(admitSudoCall(id, 1_001)).toBeNull()
    })

    it("fails closed on a floor it cannot read or write, and without an identity file", () => {
        const malformed = identity()
        writeFileSync(sudoFloorPath(malformed), "{not json")
        expect(admitSudoCall(malformed, 5_000)).toContain("malformed")

        const unwritable = identity()
        mkdirSync(sudoFloorPath(unwritable))
        expect(admitSudoCall(unwritable, 5_000)).not.toBeNull()

        expect(admitSudoCall(undefined, 5_000)).toContain("identity file")
        expect(admitSudoCall(identity(), undefined)).toContain("timestamp")
    })
})
