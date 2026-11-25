import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./loader"

const key = "SIGNALING_REGISTER_MODE"
const saved = process.env[key]

afterEach(() => {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
})

describe("SIGNALING_REGISTER_MODE", () => {
    it("passes the selected mode to the base and devnet node containers", () => {
        const root = join(import.meta.dir, "../..")
        const parse = (file: string) => (Bun as unknown as {
            YAML: { parse(text: string): { services: { node: { environment: Record<string, string> } } } }
        }).YAML.parse(readFileSync(join(root, file), "utf8"))
        const base = parse("docker-compose.yml").services.node.environment
        const devnet = parse("docker-compose.devnet.yml").services.node.environment
        for (const environment of [base, { ...base, ...devnet }]) {
            expect(environment.SIGNALING_REGISTER_MODE).toBe("${SIGNALING_REGISTER_MODE:-transitional}")
        }
    })
    it("defaults to transitional", () => {
        delete process.env[key]
        expect(loadConfig().core.signalingRegisterMode).toBe("transitional")
    })

    it("loads strict mode", () => {
        process.env[key] = "strict"
        expect(loadConfig().core.signalingRegisterMode).toBe("strict")
    })

    it("refuses an unknown mode", () => {
        process.env[key] = "strcit"
        expect(() => loadConfig()).toThrow(/SIGNALING_REGISTER_MODE/)
    })
})
