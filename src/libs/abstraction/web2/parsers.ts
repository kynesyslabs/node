import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"
import log from "@/utilities/logger"

export abstract class Web2ProofParser {
    formats = {
        twitter: ["https://x.com", "https://twitter.com"],
        discord: [
            "https://discord.com/channels",
            "https://ptb.discord.com/channels",
            "https://canary.discord.com/channels",
            "https://discordapp.com/channels",
        ],
    }

    constructor() {}

    verifyProofFormat(proofUrl: string, context: string) {
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
