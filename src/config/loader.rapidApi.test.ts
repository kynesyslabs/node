import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { loadConfig } from "./loader"

const HOST = "twitter-api45.p.rapidapi.com"
const KEY = "RAPID_API_HOST"
const saved = process.env[KEY]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
})

describe("RapidAPI host", () => {
    it("defaults to the Twitter API45 host when absent from an existing .env", () => {
        delete process.env[KEY]
        expect(loadConfig().identity.rapidApiHost).toBe(HOST)
    })

    it("uses the default for an empty Compose environment value", () => {
        process.env[KEY] = ""
        expect(loadConfig().identity.rapidApiHost).toBe(HOST)
    })

    it("preserves an operator's explicit host", () => {
        process.env[KEY] = "custom-twitter-provider.example"
        expect(loadConfig().identity.rapidApiHost).toBe(process.env[KEY])
    })

    it("passes the host override into the Compose node service", () => {
        // Bun.YAML exists at runtime but not in the pinned bun-types.
        const yaml = (
            Bun as unknown as {
                YAML: { parse(text: string): unknown }
            }
        ).YAML
        const compose = yaml.parse(
            readFileSync(
                new URL("../../docker-compose.yml", import.meta.url),
                "utf8",
            ),
        ) as {
            services: { node: { environment: Record<string, string> } }
        }
        expect(compose.services.node.environment[KEY]).toBe(
            "${RAPID_API_HOST:-}",
        )
    })

    it("documents the default alongside the API key in the install template", () => {
        const template = readFileSync(
            new URL("../../.env.example", import.meta.url),
            "utf8",
        )
        const rapidApi = template.match(
            /^#RAPID_API_KEY=.*\n#RAPID_API_HOST=.*$/m,
        )?.[0]
        expect(rapidApi).toBe(`#RAPID_API_KEY=\n#RAPID_API_HOST=${HOST}`)
    })
})
