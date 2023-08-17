
// INFO Calling demos.skeletons.NAME provides an empty skeleton that can be used for reference while calling other demos functions
// SECTION Objects skeletons
let skeletons = {
    // INFO An empty transaction
    transaction: {
        content: {
            type: "", // string
            from: null, // forge.pki.ed25519.BinaryBuffer
            to: null, // forge.pki.ed25519.BinaryBuffer
            amount: 0, // number
            data: ["", ""], // [string, string] // type as string and content in hex string
            nonce: 0, // number // Increments every time a transaction is sent from the same account
            timestamp: 0, // number // Is the registered unix timestamp when the transaction was sent the first time
            lock_fee: 0, // LockFee // Is the signed message where the sender locks X tokens until the tx is confirmed}, // TransactionContent
        },
        signature: null, // pki.ed25519.BinaryBuffer
        hash: null, // string
        confirmations: [], // Confirmation[]
        state_changes: [], // StateChange[] 
    },
    // INFO An empty crosschain operation object
    crosschain_operation: {
        // TODO Implement as specified in multichainDispatcher.js if any
    },
}
// !SECTION Objects skeletons

exports.skeletons = skeletons