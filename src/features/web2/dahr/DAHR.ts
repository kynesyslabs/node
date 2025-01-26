import {
    IAttestationWithResponse,
    IDAHRStartProxyParams,
    IWeb2Request,
} from "@kynesyslabs/demosdk/types"
import { Web2RequestManager } from "src/features/web2/Web2RequestManager"
import { Proxy } from "src/features/web2/proxy/Proxy"
import { ProxyFactory } from "src/features/web2/proxy/ProxyFactory"
import required from "src/utilities/required"
import { generateUniqueId } from "src/utilities/generateUniqueId"

/**
 * DAHR - Data Agnostic HTTPS Relay, class that handles the Web2 request and attestation process.
 */
export class DAHR {
    private readonly _sessionId: string
    private readonly _proxy: Proxy

    /**
     * Constructor for the DAHR class.
     *
     * This constructor initializes a new DAHR (Data Agnostic HTTPS Relay) instance.
     * It sets up the necessary components to handle Web2 requests and manage the attestation process.
     *
     * @param {IWeb2Request} _web2Request - The Web2 request to handle. This object contains all
     * the necessary information about the request, including the raw request data, any existing
     * results, attestations, and a hash of the request. It's used to initialize the DAHR instance
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
     * Start the proxy and return the attestation with the response.
     * @returns {Promise<IAttestationWithResponse>} The attestation with the response.
     */
    async startProxy({
        method,
        headers,
        payload,
        authorization,
    }: IDAHRStartProxyParams): Promise<IAttestationWithResponse> {
        // Make sure we have a web2Request at this point
        required(this._web2Request, "web2Request")

        const web2RequestManager = new Web2RequestManager(this)
        const web2Response = await this._proxy.sendHTTPRequest({
            web2Request: this._web2Request,
            targetMethod: method,
            targetHeaders: headers,
            payload,
            targetAuthorization: authorization,
        })

        const attestedResult =
            web2RequestManager.getAttestedResult(web2Response)

        return {
            ...attestedResult,
            web2Response,
        }
    }

    /**
     * Stop the proxy.
     */
    stopProxy(): void {
        this._proxy.stopProxy()
    }

    /**
     * Convert the DAHR instance to a serializable object.
     * @returns {{sessionId: string, web2Request: IWeb2Request}} A serializable object representing the DAHR instance.
     */
    toSerializable(): {
        sessionId: string
        web2Request: IWeb2Request
        startProxy: string
        stopProxy: string
    } {
        return {
            sessionId: this.sessionId,
            web2Request: {
                raw: this.web2Request.raw,
                result: this.web2Request.result,
                attestations: this.web2Request.attestations,
                hash: this.web2Request.hash,
                signature: this.web2Request.signature,
            },
            startProxy: "web2ProxyRequest",
            stopProxy: "web2ProxyRequest",
        }
    }
}
