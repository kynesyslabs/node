export interface ValidationData {
    signatures: { [key: string]: string }
}

export interface ConsensusHashResponse {
    success: boolean
    hash: string
    validation_data: [string, string] // [public_key, signature]
}
