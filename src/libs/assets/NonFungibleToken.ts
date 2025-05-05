// INFO Basic extensible non fungible token implementation

// Internal metadata for single tokens
interface TokenMetadata {
    name: string
    description: string
    // Other metadata specific to this NFT can be added here
}

// Interface for the whole token metadata representation
interface TokenMetadataInterface {
    tokenID: string
    metadata: TokenMetadata
}

// A NFT contract like this implements the above interfaces
export default class NonFungibleToken {
    public tokenType: string
    public tokenName: string
    public symbol: string
    public totalSupply: string
    public tokenMetadata: TokenMetadataInterface[]

    constructor() {}
}
