import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

/** The well-known path a domain owner hosts to prove control. */
export const DOMAIN_PROOF_PATH = "/.well-known/demos-cci.txt"

/** The account a web2 identity payload says it is linking. */
export type Web2Claim = {
    username?: string
    userId?: string | number
}

/**
 * Handles are compared without regard to case: Twitter, GitHub and Discord
 * all treat `Alice` and `alice` as one account.
 */
export function sameHandle(a: unknown, b: unknown): boolean {
    return (
        typeof a === "string" &&
        typeof b === "string" &&
        a.trim().length > 0 &&
        a.trim().toLowerCase() === b.trim().toLowerCase()
    )
}

/**
 * The one spelling of a numeric account id: decimal digits with no sign,
 * padding or leading zero. Stored ids are compared as exact text (the
 * duplicate check in apply and the cross-account first-connection lookup),
 * so " 42 " or "042" would count as an account that has never been linked.
 */
export function isCanonicalNumericId(id: unknown): id is string {
    return typeof id === "string" && /^[1-9][0-9]{0,31}$/.test(id)
}

/**
 * The claimed id must be canonical and equal the provider's id. Providers
 * return ids as strings, except GitHub, which returns a number.
 */
export function sameId(provided: unknown, claimed: unknown): boolean {
    const providedText =
        typeof provided === "number" && Number.isSafeInteger(provided)
            ? String(provided)
            : provided
    return (
        typeof providedText === "string" &&
        isCanonicalNumericId(claimed) &&
        providedText === claimed
    )
}

/**
 * Contexts whose claimed id is checked against a provider id here. Telegram
 * is not among them: its id is compared exactly with the bot-signed
 * attestation, and that check also runs when a block is applied, where a new
 * rule would change how existing blocks replay.
 */
const NUMERIC_ID_CONTEXTS = new Set(["twitter", "github", "discord"])

/**
 * Handles these providers treat case-insensitively, in lower case. The edit
 * is signed by the client, so the node refuses another spelling rather than
 * rewriting it, and one account has exactly one stored handle.
 */
const CANONICAL_HANDLES: Record<string, RegExp> = {
    twitter: /^[a-z0-9_]{1,15}$/,
    github: /^[a-z0-9][a-z0-9-]{0,38}$/,
}

/**
 * Returns why a web2 claim is not in canonical form, or null when it is.
 * Checked before any provider call, so a malformed claim costs nothing.
 */
export function nonCanonicalClaim(
    context: string,
    claim: Web2Claim,
): string | null {
    if (NUMERIC_ID_CONTEXTS.has(context) && !isCanonicalNumericId(claim.userId)) {
        return `${context} user id must be a decimal string with no spaces or leading zeros`
    }
    const handle = CANONICAL_HANDLES[context]
    if (handle && !(typeof claim.username === "string" && handle.test(claim.username))) {
        return `${context} username must be sent in lower case, without spaces`
    }
    return null
}

export abstract class Web2ProofParser {
    formats = {
        github: [
            "https://gist.github.com",
            "https://gist.githubusercontent.com",
        ],
        twitter: ["https://x.com", "https://twitter.com"],
        discord: [
            "https://discord.com/channels",
            "https://ptb.discord.com/channels",
            "https://canary.discord.com/channels",
            "https://discordapp.com/channels",
        ],
        // `domain` is validated structurally below (https + exact
        // DOMAIN_PROOF_PATH), not via this prefix list.
        domain: ["https://"],
    }

    constructor() {}

    verifyProofFormat(proofUrl: string, context: string) {
        // A domain proof must be the well-known file served over https on the
        // claimed host. Enforcing the full shape here — the choke point every
        // parser's readData runs through — means no opcode can route a domain
        // proof past the path/scheme check (it previously lived only in
        // verifyWeb2Proof, so a new caller could bypass it).
        if (context === "domain") {
            let url: URL
            try {
                url = new URL(proofUrl)
            } catch {
                throw new Error("Invalid domain proof URL")
            }
            if (url.protocol !== "https:") {
                throw new Error("Domain proof URL must use https")
            }
            if (url.pathname !== DOMAIN_PROOF_PATH) {
                throw new Error(
                    `Domain proof must be hosted at ${DOMAIN_PROOF_PATH}`,
                )
            }
            // A non-default port lets a claim ride on a service the domain owner
            // may not control (URL.hostname strips the port, so the host<->claim
            // check alone would pass example.com:9999). Require the default 443.
            if (url.port !== "") {
                throw new Error(
                    "Domain proof URL must use the default https port",
                )
            }
            return
        }

        if (
            !this.formats[context].some((format: string) =>
                proofUrl.startsWith(format),
            )
        ) {
            // construct informative error message
            const errorMessage = `Invalid ${context} proof format. Supported formats are: ${this.formats[
                context
            ].join(", ")}`
            throw new Error(errorMessage)
        }
    }

    /**
     * Parses the payload from the payload text to an object
     *
     * @param data - The payload text
     */
    parsePayload(data: string) {
        try {
            const splits = data.split(":")
            if (splits.length !== 4) {
                throw new Error("Invalid proof format")
            }

            return {
                message: splits[1],
                type: splits[2] as SigningAlgorithm,
                signature: splits[3],
            }
        } catch (error) {
            log.error(error)
            return null
        }
    }

    /**
     * Returns the payload from the proof url
     */
    abstract readData(
        proofUrl: string,
        claim?: Web2Claim,
    ): Promise<{
        message: string
        type: SigningAlgorithm
        signature: string
    }>

    static getInstance(): Promise<Web2ProofParser> {
        throw new Error("Not implemented")
    }
}
