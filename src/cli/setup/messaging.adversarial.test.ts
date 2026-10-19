import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { runCli } from "./cli"
import { parseEnv } from "./envFile"
import { parseMessagingEnabled } from "../../config/envFlags"
import { fakeRunner, makeRoot, recorder, removeRoot, scriptedPrompter, writeSubnet } from "./testSupport"

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

describe("answering no to messaging when the file already turns it on", () => {
    // Flags settle every other question, so the only prompts are the messaging
    // question and, when the value in the file differs, the confirmation.
    async function interactive(existing: string, answers: string[]) {
        fs.writeFileSync(path.join(root, ".env"), `L2PS_MESSAGING_ENABLED=${existing}\n`)
        const p = scriptedPrompter(answers)
        const r = recorder()
        const code = await runCli(
            ["--only", "l2ps", "--l2ps-uid", "s1", "--l2ps-role", "create", "--l2ps-rpc", "http://a:1", "--history-retention-days", "0", "--no-history-store-plaintext", "--no-history-require-v2"],
            { cwd: root, env: {}, isTTY: true, say: r.say, prompter: p, runner: fakeRunner(), inDocker: false },
        )
        return { code, asked: p.asked, out: r.text() }
    }

    it("turns it off whenever the node reads the current value as on", async () => {
        for (const on of ["true", "TRUE", "True", "tRuE", "1"].filter(v => parseMessagingEnabled(v))) {
            const { code, asked } = await interactive(on, ["n", "y"])
            expect([on, code]).toEqual([on, 0])
            expect(asked.some(q => q.includes("instant-messaging") && q.includes("[Y/n]"))).toBe(true)
            expect([on, envOf().L2PS_MESSAGING_ENABLED]).toEqual([on, "false"])
        }
    })

    it("which includes TRUE and True, which the other flags read as off", async () => {
        expect(parseMessagingEnabled("TRUE")).toBe(true)
        expect(parseMessagingEnabled("True")).toBe(true)
    })

    it("leaves the file alone when the node already reads it as off and the answer is no", async () => {
        for (const off of ["yes", "on", "0", "false", "FALSE"]) {
            const { code } = await interactive(off, ["n"])
            expect([off, code]).toEqual([off, 0])
            expect([off, envOf().L2PS_MESSAGING_ENABLED]).toEqual([off, off])
        }
    })

    it("writes true when the node reads the current value as off and the answer is yes", async () => {
        const { code } = await interactive("yes", ["y", "", "y"])
        expect(code).toBe(0)
        expect(envOf().L2PS_MESSAGING_ENABLED).toBe("true")
    })
})
