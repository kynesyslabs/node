/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"

export interface TxFee {
    network_fee: number
    rpc_fee: number
    additional_fee: number
}

export interface TransactionContent {
    type: string
    from: forge.pki.ed25519.BinaryBuffer
    to: forge.pki.ed25519.BinaryBuffer
    amount: number
    data: [string, string] // type as string and content in hex string
    nonce: number // Increments every time a transaction is sent from the same account
    timestamp: number // Is the registered unix timestamp when the transaction was sent the first time
    transaction_fee: TxFee // Is the signed message where the sender locks X tokens until the tx is confirmed
}
