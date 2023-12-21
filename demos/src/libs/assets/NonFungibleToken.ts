// INFO Basic extensible non fungible token implementation

// Internal metadata for single tokens
interface tokenMetadata {
    name: string
    description: string
    // Other metadata specific to this NFT can be added here
}

// Interface for the whole token metadata representation
interface tokenMetadataInterface {
    tokenID: string
    metadata: tokenMetadata
}

// A NFT contract like this implements the above interfaces
export default class nonFungibleToken {

    public tokenType: string
    public tokenName: string
    public symbol: string
    public totalSupply: string
    public tokenMetadata: tokenMetadataInterface[]

    constructor() {}
}

