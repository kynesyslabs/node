import axios from "axios"
import https from "https"
import dns from "dns"
import ipaddr from "ipaddr.js"
import { Web2ProofParser, DOMAIN_PROOF_PATH } from "./parsers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import SharedState from "@/utilities/sharedState"
import log from "src/utilities/logger"

// Defined in ./parsers (the format choke point) and re-exported here so the
// existing import site (verifyWeb2Proof) keeps resolving it from ./web2/domain.
export { DOMAIN_PROOF_PATH }

/** Max bytes we read from a well-known file — the proof payload is tiny. */
const MAX_PROOF_BYTES = 4096

/** Non-public ranges tolerated only outside production (for local testing). */
const DEV_ALLOWED_RANGES = new Set(["loopback", "private", "uniqueLocal"])

/**
 * SSRF guard for the attacker-controlled proof URL.
 *
 * The proof URL is supplied by the caller, so without this a request could be
 * pointed at internal services or the cloud-metadata endpoint
 * (e.g. 169.254.169.254) and the response read back. We resolve every A/AAAA
 * record and reject non-public targets:
 *
 * - link-local (incl. metadata), multicast, broadcast, reserved and CGNAT are
 *   blocked in ALL environments;
 * - loopback / private / unique-local are blocked in production but allowed
 *   in dev, so local hosts (e.g. localhost) stay testable.
 *
 * @param allowLocal Permit loopback/private/unique-local (true outside prod).
 */
async function resolveAndValidateHost(
    hostname: string,
    allowLocal: boolean,
): Promise<{ address: string; family: number }> {
    let resolved: { address: string; family: number }[]
    try {
        resolved = await dns.promises.lookup(hostname, { all: true })
    } catch {
        throw new Error(`Could not resolve host: ${hostname}`)
    }
    if (resolved.length === 0) {
        throw new Error(`Could not resolve host: ${hostname}`)
    }

    for (const { address } of resolved) {
        let addr = ipaddr.parse(address)
        // Classify the embedded v4 for IPv4-mapped IPv6 (::ffff:a.b.c.d).
        if (
            addr.kind() === "ipv6" &&
            (addr as ipaddr.IPv6).isIPv4MappedAddress()
        ) {
            addr = (addr as ipaddr.IPv6).toIPv4Address()
        }
        const range = addr.range()
        if (range === "unicast") continue
        if (allowLocal && DEV_ALLOWED_RANGES.has(range)) continue
        throw new Error(
            `Refusing to fetch from non-public address: ${hostname} (${address}, ${range})`,
        )
    }

    // Return the first validated address so the caller can pin the socket to it
    // (prevents DNS-rebinding between this check and connect time).
    return resolved[0]
}

/**
 * Fetch a domain ownership proof file over HTTPS.
 *
 * The TLS certificate, validated during the handshake, binds the response to
 * the requested hostname — so a successful fetch is itself proof that the
 * content was served from a host presenting a valid cert for that domain.
 *
 * In production, certificate validation and the SSRF public-address check are
 * enforced; both are relaxed in dev so local self-signed hosts (e.g. localhost)
 * can be tested.
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

    const isProd = SharedState.getInstance().PROD

    // SSRF guard: block internal / metadata targets. Loopback/private hosts are
    // permitted only in dev so local test servers (localhost) remain reachable.
    const pinned = await resolveAndValidateHost(parsed.hostname, !isProd)

    // Pin the socket to the validated IP so DNS cannot rebind to an internal
    // address between the check above and connect time. The URL still carries
    // the original hostname, so the Host header and TLS SNI / cert validation
    // are unchanged; only the address the socket dials is forced.
    const agent = new https.Agent({
        rejectUnauthorized: isProd,
        lookup: (
            _hostname: string,
            options: { all?: boolean },
            callback: (...args: any[]) => void,
        ) => {
            if (options && options.all) {
                callback(null, [
                    { address: pinned.address, family: pinned.family },
                ])
            } else {
                callback(null, pinned.address, pinned.family)
            }
        },
    } as https.AgentOptions)

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
            const errorMsg =
                error instanceof Error ? error.message : String(error)
            // Full detail (resolved IP / range from the SSRF guard) stays in the
            // server log; the thrown message is static so verifyWeb2Proof cannot
            // leak internal network info back to the caller.
            log.error(
                `[DOMAIN] Failed to fetch proof for ${proofUrl}: ${errorMsg}`,
            )
            throw new Error("Failed to fetch domain proof")
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
