import axios from "axios"
import https from "https"
import { Web2ProofParser } from "./parsers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import SharedState from "@/utilities/sharedState"
import log from "src/utilities/logger"

/** The well-known path a domain owner hosts to prove control. */
export const DOMAIN_PROOF_PATH = "/.well-known/demos-cci.txt"

/** Max bytes we read from a well-known file — the proof payload is tiny. */
const MAX_PROOF_BYTES = 4096

/**
 * Fetch a domain ownership proof file over HTTPS.
 *
 * The TLS certificate, validated during the handshake, binds the response to
 * the requested hostname — so a successful fetch is itself proof that the
 * content was served from a host presenting a valid cert for that domain.
 * (Certificate validation is enabled in production and relaxed in dev so local
 * self-signed hosts can be tested.)
 *
 * @param url Full proof URL, e.g. https://example.com/.well-known/demos-cci.txt
 * @returns The trimmed file body and the verified hostname.
 */
export async function fetchDomainProof(
    url: string,
): Promise<{ hostname: string; body: string }> {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") {
        throw new Error("Domain proof URL must use https")
    }

    const verifyCertificates = SharedState.getInstance().PROD
    const agent = new https.Agent({ rejectUnauthorized: verifyCertificates })

    const response = await axios.get(url, {
        httpsAgent: agent,
        responseType: "text",
        maxContentLength: MAX_PROOF_BYTES,
        maxRedirects: 0,
        timeout: 10_000,
        // The proof file is plain text; never follow it as JSON.
        transformResponse: r => r,
        headers: { Accept: "text/plain" },
    })

    const body =
        typeof response.data === "string"
            ? response.data.trim()
            : String(response.data).trim()

    return { hostname: parsed.hostname, body }
}

export class DomainProofParser extends Web2ProofParser {
    private static instance: DomainProofParser

    constructor() {
        super()
    }

    async readData(
        proofUrl: string,
    ): Promise<{ message: string; type: SigningAlgorithm; signature: string }> {
        this.verifyProofFormat(proofUrl, "domain")

        let body: string
        try {
            ;({ body } = await fetchDomainProof(proofUrl))
        } catch (error) {
            log.error("[DOMAIN] Failed to fetch proof: " + error)
            throw new Error(
                `Failed to read domain proof at ${proofUrl}`,
            )
        }

        const payload = this.parsePayload(body)
        if (!payload) {
            throw new Error("Invalid domain proof format")
        }

        return payload
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new this()
        }
        return this.instance
    }
}
