// Importing Proxy pulls the node runtime in (SharedState -> chain -> logger ->
// PeerManager). Both config objects are passed explicitly below, so none of it
// is actually exercised — stub the modules so the suite stays a unit test.
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))
jest.mock("src/libs/crypto/hashing", () => ({
    __esModule: true,
    default: { sha256: (v: string) => v },
}))

import { Proxy } from "./Proxy"

/**
 * Build a Proxy with both config objects supplied so construction never reaches
 * SharedState — these tests are about header shaping, not runtime environment.
 */
function makeProxy(requireAuthForAll: boolean) {
    return new Proxy(
        "test-session-id",
        "localhost",
        { requireAuthForAll, exceptions: [] },
        { verifyCertificates: false },
    )
}

/** `createHeaders` is private; TS visibility is compile-time only. */
function headersFor(
    proxy: Proxy,
    targetAuthorization: string,
): Record<string, string> {
    return (proxy as any).createHeaders(
        "GET",
        {},
        targetAuthorization,
    ) as Record<string, string>
}

describe("Proxy outbound Authorization header", () => {
    it("is omitted when the caller supplied no token, even in production", () => {
        // The regression: `requireAuthForAll` is true on production, and the
        // outbound header used to be keyed on it. Every proxied request then
        // carried `Bearer undefined`, which GitHub rejects (401 on
        // api.github.com, 404 on raw.githubusercontent.com) while permissive
        // targets like httpbin ignore it — hence "DAHR works but GitHub 401s".
        const headers = headersFor(makeProxy(true), "")

        expect(headers).not.toHaveProperty("Authorization")
        expect(Object.values(headers).join(" ")).not.toContain("undefined")
    })

    it("forwards the token the caller did supply", () => {
        const headers = headersFor(makeProxy(true), "ghp_realtoken")

        expect(headers["Authorization"]).toBe("Bearer ghp_realtoken")
    })

    it("forwards a supplied token off production too, rather than dropping it", () => {
        // Keying the header on the inbound-access flag also meant a token
        // passed in development was silently discarded.
        const headers = headersFor(makeProxy(false), "ghp_realtoken")

        expect(headers["Authorization"]).toBe("Bearer ghp_realtoken")
    })

    it("still stamps the session id that gates inbound proxy access", () => {
        // The inbound control must be untouched by the outbound change.
        expect(headersFor(makeProxy(true), "")["x-dahr-session-id"]).toBe(
            "test-session-id",
        )
    })
})
