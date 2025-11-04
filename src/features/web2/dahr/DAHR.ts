import {
    IDAHRStartProxyParams,
    IWeb2Request,
    IWeb2Result,
} from "@kynesyslabs/demosdk/types"
import { Proxy } from "src/features/web2/proxy/Proxy"
import { ProxyFactory } from "src/features/web2/proxy/ProxyFactory"
import required from "src/utilities/required"
import { generateUniqueId } from "src/utilities/generateUniqueId"
import { EnumWeb2Actions } from "@kynesyslabs/demosdk/types"
import { validateAndNormalizeHttpUrl } from "src/features/web2/validator"

const SENSITIVE_HEADER_KEYS = new Set([
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-access-token",
    "x-authorization",
    "x-session-token",
    "cookie",
    "set-cookie",
])

type Web2Headers = NonNullable<IWeb2Request["raw"]["headers"]>

function sanitizeHeaders(
    headers?: IWeb2Request["raw"]["headers"],
): IWeb2Request["raw"]["headers"] {
    if (!headers) {
        return headers
    }

    const sanitized: Partial<Web2Headers> = {}

    for (const key of Object.keys(headers)) {
        if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
            continue
        }

        sanitized[key] = headers[key]
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

/**
 * DAHR - Data Agnostic HTTPS Relay, class that handles the Web2 request and proxy process.
 */
export class DAHR {
    private readonly _sessionId: string
    private readonly _proxy: Proxy

    /**
     * Constructor for the DAHR class.
     *
     * This constructor initializes a new DAHR (Data Agnostic HTTPS Relay) instance.
     * It sets up the necessary components to handle Web2 requests and manage the proxy process.
     *
     * @param {IWeb2Request} _web2Request - The Web2 request to handle. This object contains all
     * the necessary information about the request, including the raw request data, any existing
     * results, and a hash of the request. It's used to initialize the DAHR instance
     * and guide its operations.
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
     * @returns {Promise<IWeb2Result>} The response from the proxy.
     */
    async startProxy({
        method,
        headers,
        payload,
        authorization,
        url,
    }: IDAHRStartProxyParams): Promise<IWeb2Result> {
        // Make sure we have a web2Request at this point
        required(this._web2Request, "web2Request")

        // Validate and normalize URL without echoing sensitive details
        const validation = validateAndNormalizeHttpUrl(url)
        if (!validation.ok) {
            const err = new Error(validation.message)
            ;(err as any).status = validation.status
            throw err
        }

        const web2Response = await this._proxy.sendHTTPRequest({
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
        })

        return web2Response
    }

    /**
     * Stop the proxy.
     */
    async stopProxy(): Promise<void> {
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
        const raw = this.web2Request.raw
        const sanitizedRaw = raw
            ? {
                  ...raw,
                  headers: sanitizeHeaders(raw.headers),
              }
            : raw

        return {
            sessionId: this.sessionId,
            web2Request: {
                raw: sanitizedRaw,
                result: this.web2Request.result,
                hash: this.web2Request.hash,
                signature: this.web2Request.signature,
            },
        }
    }
}
