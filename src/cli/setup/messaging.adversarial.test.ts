import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { runCli } from "./cli"
import { parseEnv } from "./envFile"
import { fakeRunner, makeRoot, recorder, removeRoot, writeSubnet } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

async function cli(argv: string[]) {
    const r = recorder()
    const code = await runCli(argv, { cwd: root, env: {}, isTTY: false, say: r.say, runner: fakeRunner(), inDocker: false })
    return { code, out: r.text() }
}
const envOf = () => (fs.existsSync(path.join(root, ".env")) ? parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8")) : {})

// A node with messaging on and no subnet prints a warning banner at every
// start, and refuses to start in strict mode. The setup must not be the thing
// that puts a node in that state.
describe("messaging needs a subnet", () => {
    it("is not switched on when there is no usable subnet, and the run says why and fails", async () => {
        const { code, out } = await cli(["--yes", "--only", "l2ps", "--messaging", "--messaging-port", "3100"])
        expect(code).toBe(1)
        expect(out).toContain("--l2ps-uid")
        expect(envOf().L2PS_MESSAGING_ENABLED).toBeUndefined()
    })

    it("is switched on together with the subnet it needs, in one run", async () => {
        const { code } = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "s1", "--messaging", "--messaging-port", "3100"])
        expect(code).toBe(0)
        expect(envOf()).toMatchObject({ L2PS_MESSAGING_ENABLED: "true", L2PS_MESSAGING_PORT: "3100" })
    })

    it("is switched on for a healthy subnet that already exists", async () => {
        writeSubnet(root, "old")
        const { code } = await cli(["--yes", "--only", "l2ps", "--messaging"])
        expect(code).toBe(0)
        expect(envOf().L2PS_MESSAGING_ENABLED).toBe("true")
    })

    it("is not switched on next to a subnet that stays broken", async () => {
        writeSubnet(root, "bad", { key: "zz" })
        const { code } = await cli(["--yes", "--only", "l2ps", "--l2ps-uid", "bad", "--messaging"])
        expect(code).toBe(1)
        expect(envOf().L2PS_MESSAGING_ENABLED).toBeUndefined()
    })

    it("can always be switched off", async () => {
        fs.writeFileSync(path.join(root, ".env"), "L2PS_MESSAGING_ENABLED=true\n")
        const { code } = await cli(["--yes", "--only", "l2ps", "--no-messaging", "--force"])
        expect(code).toBe(0)
        expect(envOf().L2PS_MESSAGING_ENABLED).toBe("false")
    })

    it("a dry run reports the same refusal and still writes nothing", async () => {
        const { out } = await cli(["--yes", "--dry-run", "--only", "l2ps", "--messaging"])
        expect(out).toContain("--l2ps-uid")
        expect(fs.existsSync(path.join(root, ".env"))).toBe(false)
    })
})
