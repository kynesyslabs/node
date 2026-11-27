import {
    IDAHRStartProxyParams,
    IWeb2Request,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"
import { Proxy, type Web2FetchMeter } from "src/features/web2/proxy/Proxy"
import { ProxyFactory } from "src/features/web2/proxy/ProxyFactory"
import required from "src/utilities/required"
import { generateUniqueId } from "src/utilities/generateUniqueId"
import { EnumWeb2Actions } from "@kynesyslabs/demosdk/types"
import { sanitizeWeb2RequestForStorage } from "src/features/web2/sanitizeWeb2Request"
import { validateAndNormalizeHttpUrl } from "src/features/web2/validator"
import {
    isSuccessStatus,
    UnattestableResponseError,
} from "src/features/web2/dahr/originStatus"
import {
    releaseAttestedBytes,
    reserveAttestedBytes,
} from "src/features/web2/dahr/attestedBudget"
import { createHash } from "node:crypto"
import {
    WEB2_ATTESTED_PER_SESSION,
    WEB2_ATTESTED_RETAIN_MS,
} from "src/utilities/constants"

export type DAHRStartProxyParams = IDAHRStartProxyParams & {
    /** Return non-2xx origin responses instead of refusing them. */
    allowNonSuccessStatus?: boolean
    /** Receives the count of origin response bytes read, whatever the outcome. */
    meter?: Web2FetchMeter
}

/**
 * DAHR - Data Agnostic HTTPS Relay, class that handles the Web2 request and proxy process.
 */
export class DAHR {
    private readonly _sessionId: string
    private readonly _proxy: Proxy
    // Newest last. The evidence of a response (its request and hashes) is
    // kept as long as the session, so a broadcast never depends on fetching
    // the origin again; its body only while it fits the node-wide budget.
    private _attested: AttestedEntry[] = []

    /**
     * Constructor for the DAHR class.
     *
     * This constructor initializes a new DAHR (Data Agnostic HTTPS Relay) instance.
     * It sets up the necessary components to handle Web2 requests and manage the proxy process.
     *
     * @param {IWeb2Request} _web2Request - The request the session keeps. The DAHR holds this
     * object as given, and a start does not change it, so whoever constructs the DAHR decides
     * its size: DAHRFactory passes a small copy of the create request.
     *
     * The constructor performs the following actions:
     * 1. Validates that a web2Request is provided (using the 'required' utility).
     * 2. Creates a new Proxy instance using the ProxyFactory.
     * 3. Generates a unique session ID for this DAHR instance.
     *
     * Note: The actual initialization of these components is done in the constructor body below.
     */
    constructor(private readonly _web2Request: IWeb2Request) {
        required(this._web2Request, "web2Request")
        this._sessionId = generateUniqueId()
        this._proxy = ProxyFactory.createProxy(this._sessionId)
    }

    /**
     * Get the web2 request.
     * @returns {IWeb2Request} The web2 request.
     */
    get web2Request(): IWeb2Request {
        return this._web2Request
    }

    /**
     * Get the session ID.
     * @returns {string} The session ID.
     */
    get sessionId(): string {
        return this._sessionId
    }

    /**
     * Start the proxy and return the response.
     *
     * A non-2xx origin status (including 3xx: redirects are not followed) is
     * refused with an `UnattestableResponseError` unless
     * `allowNonSuccessStatus` is set; the returned `status` then carries it.
     * @returns {Promise<IWeb2Result>} The response from the proxy.
     */
    async startProxy({
        method,
        headers,
        payload,
        authorization,
        url,
        allowNonSuccessStatus = false,
        meter,
    }: DAHRStartProxyParams): Promise<IWeb2Result> {
        // Make sure we have a web2Request at this point
        required(this._web2Request, "web2Request")

        // Validate and normalize URL without echoing sensitive details
        const validation = validateAndNormalizeHttpUrl(url)
        if (!validation.ok) {
            // Explicit narrowing needed due to strictNullChecks: false
            const failed = validation as {
                ok: false
                status: 400
                message: string
            }
            const err = new Error(failed.message)
            ;(err as any).status = failed.status
            throw err
        }

        const web2Response: IWeb2Result = await this._proxy.sendHTTPRequest({
            web2Request: {
                ...this._web2Request,
                raw: {
                    ...this._web2Request.raw,
                    action: EnumWeb2Actions.START_PROXY,
                    url: validation.normalizedUrl,
                },
            },
            targetMethod: method,
            targetHeaders: headers,
            payload,
            targetAuthorization: authorization,
        }, meter)

        // An error page attested as data is indistinguishable from the real
        // thing to anyone reading the chain, so it needs an explicit opt-in.
        if (!allowNonSuccessStatus && !isSuccessStatus(web2Response.status)) {
            const statusLine =
                `${web2Response.status} ${web2Response.statusText ?? ""}`.trim()
            throw new UnattestableResponseError(
                `Origin responded with HTTP ${statusLine}; ` +
                    "non-2xx responses are not attested unless the request " +
                    "sets the allowNonSuccessStatus parameter",
                "origin-non-2xx",
                502,
                web2Response.status,
            )
        }

        this.keepAttested(validation.normalizedUrl, method, web2Response, meter)
        return web2Response
    }

    private keepAttested(
        url: string,
        method: string,
        response: IWeb2Result,
        meter?: Web2FetchMeter,
    ): void {
        if (typeof response.responseHash !== "string") return
        const entry: AttestedEntry = {
            request: requestKey(url, method),
            status: response.status,
            statusText: String(response.statusText ?? "").slice(0, ATTESTED_STATUS_TEXT_MAX),
            responseHash: response.responseHash,
            responseHeadersHash: response.responseHeadersHash,
            requestHash: response.requestHash,
            body: null,
        }
        const bytes = attestedSize(response, meter)
        if (reserveAttestedBytes(bytes)) {
            const expiry = setTimeout(() => dropBody(entry), WEB2_ATTESTED_RETAIN_MS)
            expiry.unref?.()
            entry.body = { result: response, bytes, expiry }
        }
        this._attested.push(entry)
        while (this._attested.length > WEB2_ATTESTED_PER_SESSION) {
            dropBody(this._attested.shift())
        }
    }

    /**
     * A response this session attested, when `url` and `method` name its
     * request and `claimed` carries its status and hashes; else null. Each is
     * handed out once, so a broadcast stands on it instead of fetching the
     * origin again, but only one broadcast. When its body is no longer kept,
     * the reply carries the status and hashes without the body.
     */
    takeAttestedResponse(
        url: string,
        method: string,
        claimed: unknown,
    ): IWeb2Result | null {
        if (!claimed || typeof claimed !== "object") return null
        const c = claimed as Partial<IWeb2Result>
        const request = requestKey(url, method)
        const index = this._attested.findIndex(
            e =>
                e.request === request &&
                c.status === e.status &&
                c.responseHash === e.responseHash &&
                c.responseHeadersHash === e.responseHeadersHash &&
                (e.requestHash === undefined || c.requestHash === e.requestHash),
        )
        if (index < 0) return null
        const [entry] = this._attested.splice(index, 1)
        const kept = entry.body?.result
        dropBody(entry)
        return (
            kept ?? {
                status: entry.status,
                statusText: entry.statusText,
                headers: {},
                data: null,
                responseHash: entry.responseHash,
                responseHeadersHash: entry.responseHeadersHash,
                ...(entry.requestHash === undefined
                    ? {}
                    : { requestHash: entry.requestHash }),
            }
        )
    }

    private dropAttested(): void {
        for (const entry of this._attested) dropBody(entry)
        this._attested = []
    }

    /**
     * Stop the proxy.
     */
    async stopProxy(): Promise<void> {
        this.dropAttested()
        await this._proxy.stopProxy()
    }

    /**
     * Convert the DAHR instance to a serializable object.
     * @returns {{sessionId: string, web2Request: IWeb2Request}} A serializable object representing the DAHR instance.
     */
    toSerializable(): {
        sessionId: string
        web2Request: IWeb2Request
    } {
        const sanitizedRequest = sanitizeWeb2RequestForStorage(this.web2Request)

        return {
            sessionId: this.sessionId,
            web2Request: {
                raw: sanitizedRequest.raw,
                result: sanitizedRequest.result,
                hash: sanitizedRequest.hash,
                signature: sanitizedRequest.signature,
            },
        }
    }
}

const ATTESTED_STATUS_TEXT_MAX = 128

interface AttestedEntry {
    // sha256 of the method and normalized URL: the URL may be 4096 chars.
    request: string
    status: number
    statusText: string
    responseHash: string
    responseHeadersHash: string
    requestHash?: string
    body: {
        result: IWeb2Result
        bytes: number
        expiry: ReturnType<typeof setTimeout>
    } | null
}

function requestKey(url: string, method: string): string {
    return createHash("sha256").update(`${method}\n${url}`).digest("hex")
}

function dropBody(entry: AttestedEntry | undefined): void {
    const body = entry?.body
    if (!body) return
    entry.body = null
    clearTimeout(body.expiry)
    releaseAttestedBytes(body.bytes)
}

// What a kept response costs: the bytes read from the origin, or its body
// when the read was not metered.
function attestedSize(result: IWeb2Result, meter?: Web2FetchMeter): number {
    if (meter && meter.bytes > 0) return meter.bytes
    const body = (result as { data?: unknown }).data
    return typeof body === "string" ? Buffer.byteLength(body) : 0
}
