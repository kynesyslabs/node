
export interface ValidationData {
    signatures: { [key: string]: string }
}

export interface ConsensusHashVote {
    hash: string
    validation_data: ValidationData
}

export interface ConsensusHashResponse {
    success: boolean
    hash: string
    validation_data: [string, string] // [public_key, signature]
}