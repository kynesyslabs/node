import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

export abstract class Web2ProofParser {
    formats = {
        github: [
            "https://gist.github.com",
            "https://raw.githubusercontent.com",
            "https://gist.githubusercontent.com",
        ],
        twitter: ["https://x.com", "https://twitter.com"],
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
            console.error(error)
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
