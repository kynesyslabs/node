export abstract class Web2ProofParser {
    url: string
    constructor(url: string) {
        this.url = url
    }

    /**
     * Returns the payload from the proof url
     */
    abstract readData(): Promise<{
        message: string
        signature: string
        publicKey: string
    }>
}

export class TwitterProofParser extends Web2ProofParser {
    constructor(tweet: string) {
        super(tweet)
    }

    async readData(): Promise<{
        message: string
        signature: string
        publicKey: string
    }> {
        const response = await fetch(this.url)
        const data = await response.json()
        return data
    }
}
