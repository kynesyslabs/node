// The origin is a real HTTP server on 127.0.0.1 and requests go through the
// real DAHR proxy. Only the SSRF guards are stubbed, since they exist to stop
// exactly this loopback target, plus the node runtime modules Proxy pulls in.
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        only: jest.fn(),
    },
}))
jest.mock("src/features/web2/validator", () => ({
    validateAndNormalizeHttpUrl: (url: string) => ({
        ok: true,
        normalizedUrl: url,
    }),
}))
// "blocked.test" stands in for a name that resolves into a private range.
jest.mock("node:dns/promises", () => ({
    __esModule: true,
    default: {
        lookup: async (host: string) => [
            {
                address: host === "blocked.test" ? "10.0.0.1" : "93.184.216.34",
                family: 4,
            },
        ],
    },
}))

import http from "http"
import { AddressInfo } from "net"
import { createHash } from "crypto"
import { EnumWeb2Actions, IWeb2Request } from "@kynesyslabs/demosdk/types"
import { skeletons } from "@kynesyslabs/demosdk/websdk"
import { DAHR } from "@/features/web2/dahr/DAHR"
import { DAHRFactory } from "@/features/web2/dahr/DAHRFactory"
import {
    ALLOW_NON_SUCCESS_STATUS_PARAM,
    UnattestableResponseError,
} from "@/features/web2/dahr/originStatus"
import { handleWeb2ProxyRequest } from "@/libs/network/routines/transactions/handleWeb2ProxyRequest"

const OK_BODY = JSON.stringify({ price: 42 })

let origin: http.Server
let originBase: string
const dahrs: DAHR[] = []

function freshWeb2Request(parameters: unknown[] = []): IWeb2Request {
    const req = structuredClone(skeletons.web2_request) as IWeb2Request
    req.raw = {
        ...req.raw,
        action: EnumWeb2Actions.START_PROXY,
        method: "GET",
        headers: {},
        parameters: parameters as IWeb2Request["raw"]["parameters"],
    }
    return req
}

async function newDahr(): Promise<DAHR> {
    const dahr = await DAHRFactory.instance.createDAHR(freshWeb2Request())
    dahrs.push(dahr)
    return dahr
}

function startProxy(dahr: DAHR, path: string, allowNonSuccessStatus?: boolean) {
    return dahr.startProxy({
        method: "GET",
        headers: {},
        url: `${originBase}${path}`,
        allowNonSuccessStatus,
    })
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
    try {
        await p
    } catch (e) {
        return e
    }
    throw new Error("expected the promise to reject")
}

beforeAll(async () => {
    origin = http.createServer((req, res) => {
        switch (req.url) {
            case "/ok":
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(OK_BODY)
                return
            case "/unauthorized":
                res.writeHead(401, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ message: "Bad credentials" }))
                return
            case "/boom":
                res.writeHead(500, { "Content-Type": "text/plain" })
                res.end("Internal Server Error")
                return
            case "/moved":
                res.writeHead(302, { Location: "/ok" })
                res.end()
                return
            case "/forged-marker":
                res.writeHead(200, { "x-dahr-proxy-error": "origin-forged" })
                res.end(OK_BODY)
                return
            default:
                res.writeHead(404)
                res.end()
        }
    })
    await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve))
    const { port } = origin.address() as AddressInfo
    // A hostname, not an IP literal, so the proxy's preflight goes through DNS.
    originBase = `http://localhost:${port}`
})

afterAll(async () => {
    await Promise.all(dahrs.map(d => d.stopProxy()))
    await new Promise<void>(resolve => origin.close(() => resolve()))
})

describe("DAHR origin status", () => {
    it("returns a 200 origin response with its status and body hash", async () => {
        const result = await startProxy(await newDahr(), "/ok")

        expect(result.status).toBe(200)
        expect(result.data).toBe(OK_BODY)
        expect(result.responseHash).toBe(
            createHash("sha256").update(OK_BODY, "utf8").digest("hex"),
        )
    })

    it("refuses a 401 origin response by default", async () => {
        const err = await rejection(startProxy(await newDahr(), "/unauthorized"))

        expect(err).toBeInstanceOf(UnattestableResponseError)
        expect((err as UnattestableResponseError).reason).toBe("origin-non-2xx")
        expect((err as UnattestableResponseError).originStatus).toBe(401)
        expect((err as Error).message).toContain("HTTP 401")
    })

    it("refuses a 500 origin response by default", async () => {
        const err = await rejection(startProxy(await newDahr(), "/boom"))

        expect(err).toBeInstanceOf(UnattestableResponseError)
        expect((err as UnattestableResponseError).originStatus).toBe(500)
        expect((err as Error).message).toContain("HTTP 500")
    })

    it("does not follow a 3xx redirect and refuses it by default", async () => {
        const err = await rejection(startProxy(await newDahr(), "/moved"))

        expect((err as UnattestableResponseError).originStatus).toBe(302)
    })

    it("returns 401 and 500 with the status visible when the caller opts in", async () => {
        const dahr = await newDahr()

        const unauthorized = await startProxy(dahr, "/unauthorized", true)
        expect(unauthorized.status).toBe(401)
        expect(unauthorized.statusText).toBe("Unauthorized")

        const boom = await startProxy(dahr, "/boom", true)
        expect(boom.status).toBe(500)
        expect(boom.data).toBe("Internal Server Error")
    })

    it("returns an opted-in 3xx as is, without following the Location", async () => {
        const result = await startProxy(await newDahr(), "/moved", true)

        expect(result.status).toBe(302)
        expect(result.headers.location).toBe("/ok")
        expect(result.data).toBe("")
    })

    it("never returns a response the proxy generated itself, even when opted in", async () => {
        const dahr = await newDahr()
        const port = (origin.address() as AddressInfo).port

        const err = await rejection(
            dahr.startProxy({
                method: "GET",
                headers: {},
                url: `http://blocked.test:${port}/ok`,
                allowNonSuccessStatus: true,
            }),
        )

        expect(err).toBeInstanceOf(UnattestableResponseError)
        expect((err as UnattestableResponseError).reason).toBe("proxy-error")
        expect((err as UnattestableResponseError).rpcStatus).toBe(400)
    })

    it("strips a proxy-error marker the origin sends itself", async () => {
        const result = await startProxy(await newDahr(), "/forged-marker")

        expect(result.status).toBe(200)
        expect(result.headers).not.toHaveProperty("x-dahr-proxy-error")
    })
})

describe("web2ProxyRequest RPC for a non-2xx origin", () => {
    async function rpc(path: string, parameters: unknown[] = []) {
        const dahr = await newDahr()
        const web2Request = freshWeb2Request(parameters)
        web2Request.raw.url = `${originBase}${path}`
        return handleWeb2ProxyRequest({
            web2Request,
            sessionId: dahr.sessionId,
            payload: undefined,
            authorization: undefined,
        })
    }

    it("answers a 401 origin with an error and no result to sign", async () => {
        const res = await rpc("/unauthorized")

        expect(res.result).toBe(502)
        expect(res.response).toBeNull()
        expect(res.extra).toContain("HTTP 401")
        expect(res.extra).toContain(ALLOW_NON_SUCCESS_STATUS_PARAM)
    })

    it("answers a 500 origin with an error and no result to sign", async () => {
        const res = await rpc("/boom")

        expect(res.result).toBe(502)
        expect(res.response).toBeNull()
        expect(res.extra).toContain("HTTP 500")
    })

    it("returns the 401 with its status when raw.parameters opts in", async () => {
        const res = await rpc("/unauthorized", [
            { name: ALLOW_NON_SUCCESS_STATUS_PARAM, value: true },
        ])

        expect(res.result).toBe(200)
        expect((res.response as { status: number }).status).toBe(401)
    })

    it("treats a non-boolean opt-in value as no opt-in", async () => {
        const res = await rpc("/unauthorized", [
            { name: ALLOW_NON_SUCCESS_STATUS_PARAM, value: "true" },
        ])

        expect(res.result).toBe(502)
        expect(res.response).toBeNull()
    })

    it("still returns a 200 origin response unchanged", async () => {
        const res = await rpc("/ok")

        expect(res.result).toBe(200)
        expect((res.response as { status: number; data: string }).status).toBe(200)
        expect((res.response as { data: string }).data).toBe(OK_BODY)
    })
})
