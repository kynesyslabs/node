export abstract class Web2ProofParser {
    constructor() {}

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
                signature: splits[2],
                publicKey: splits[3],
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
        signature: string
        publicKey: string
    }>

    static getInstance(): Promise<Web2ProofParser> {
        throw new Error("Not implemented")
    }
}
