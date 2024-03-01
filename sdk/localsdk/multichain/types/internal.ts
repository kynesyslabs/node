/**
 * The response of a XM transaction
 */
export interface TransactionResponse {
    /**
     * `"success"` | `"error"`
     */
    result: string

    /**
     * The hash of the transaction if it was successful
     */
    hash?: string

    /**
     * The error object if the transaction failed
     */
    error?: any
}
