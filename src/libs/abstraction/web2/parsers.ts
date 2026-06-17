import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

/** The well-known path a domain owner hosts to prove control. */
export const DOMAIN_PROOF_PATH = "/.well-known/demos-cci.txt"

export abstract class Web2ProofParser {
    formats = {
        github: [
            "https://gist.github.com",
            "https://raw.githubusercontent.com",
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
    abstract readData(proofUrl: string): Promise<{
        message: string
        type: SigningAlgorithm
        signature: string
    }>

    static getInstance(): Promise<Web2ProofParser> {
        throw new Error("Not implemented")
    }
}
