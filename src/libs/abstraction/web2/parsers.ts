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
    constructor(tweetUrl: string) {
        super(tweetUrl)
    }

    async readData(): Promise<{
        message: string
        signature: string
        publicKey: string
    }> {
        return {
            message: "hi",
            signature:
                "6313be95e90b2be4c69db9124d3fa62d196080318b1f4eb95a7cbac4c6dd77f22de9391b9b7894327fa7e73049eba57bbdfa6a3aac8e868ce23aa9ff1e5b3605",
            publicKey:
                "be065600833f72f3ff4d2f0ed16cc663bbd31ba607ebca0a6748ae3f98665492",
        }
    }
}
