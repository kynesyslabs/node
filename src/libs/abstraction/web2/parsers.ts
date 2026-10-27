import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"
import { canonicalWeb2UserId, sameWeb2UserId } from "@/libs/identity/web2UserId"

/** The well-known path a domain owner hosts to prove control. */
export const DOMAIN_PROOF_PATH = "/.well-known/demos-cci.txt"

/** The account a web2 identity payload says it is linking. */
export type Web2Claim = {
    username?: string
    userId?: string | number
}

/**
 * Handles are compared without regard to case: Twitter, GitHub and Discord
 * all treat `Alice` and `alice` as one account. No trimming: a padded handle
 * is not the provider's spelling of any account.
 */
export function sameHandle(a: unknown, b: unknown): boolean {
    return (
        typeof a === "string" &&
        typeof b === "string" &&
        a.length > 0 &&
        a.toLowerCase() === b.toLowerCase()
    )
}

/**
 * The provider's id and the claimed id name the same account. GitHub returns
 * a number, the others a string; the SDK passes them on as received.
 */
export function sameId(provided: unknown, claimed: unknown): boolean {
    return sameWeb2UserId(provided, claimed)
}

/**
 * Contexts whose claimed id is checked against a provider id here. Telegram
 * is not among them: its id is compared exactly with the bot-signed
 * attestation, and that check also runs when a block is applied, where a new
 * rule would change how existing blocks replay.
 */
const NUMERIC_ID_CONTEXTS = new Set(["twitter", "github", "discord"])

/** Contexts whose handle is checked against the provider's account. */
const HANDLE_CONTEXTS = new Set(["twitter", "github"])

/**
 * Returns why a web2 claim is malformed, or null when it is well formed.
 * Checked before any provider call, so a malformed claim costs nothing.
 */
export function nonCanonicalClaim(
    context: string,
    claim: Web2Claim,
): string | null {
    if (NUMERIC_ID_CONTEXTS.has(context) && canonicalWeb2UserId(claim.userId) === null) {
        return `${context} user id must be a whole number with no spaces or leading zeros`
    }
    if (
        HANDLE_CONTEXTS.has(context) &&
        !(typeof claim.username === "string" && /^\S+$/.test(claim.username))
    ) {
        return `${context} username must not be empty or contain spaces`
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
