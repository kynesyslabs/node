import { describe, expect, test } from "bun:test"

import { BunServer, cors, json, jsonResponse } from "./bunServer"

describe("BunServer routing", () => {
    test("matches GET routes with path params", async () => {
        const server = new BunServer(0)
        server.use(cors())
        server.use(json())
        server.get("/items/:id", req => {
            const params = (req as Request & {
                params?: Record<string, string>
            }).params ?? {}
            return jsonResponse({ id: params.id })
        })

        const response = await (server as unknown as {
            handleRequest(req: Request): Promise<Response>
        }).handleRequest(new Request("http://localhost/items/abc123"))

        expect(response.status).toBe(200)
        expect(response.headers.get("Content-Type")).toBe("application/json")
        await expect(response.json()).resolves.toEqual({ id: "abc123" })
    })

    test("keeps unknown routes as 404 structured JSON", async () => {
        const server = new BunServer(0)
        server.use(cors())
        server.use(json())

        const response = await (server as unknown as {
            handleRequest(req: Request): Promise<Response>
        }).handleRequest(new Request("http://localhost/does-not-exist"))

        expect(response.status).toBe(404)
        expect(response.headers.get("Content-Type")).toBe("application/json")
        await expect(response.json()).resolves.toEqual({ error: "Not Found" })
    })
})
