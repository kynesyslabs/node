import forge from "node-forge"
import Transaction from "src/libs/blockchain/transaction"

import Identity from "../libs/identity/identity"
import testingEnvironment from "./types/testingEnvironment"

const term = require("terminal-kit").terminal

async function main() {
    // Loading the environment
    let environment = await testingEnvironment.retrieve()
    // Welcome
    term.brightBlack.bgWhite("[DEMOS INFRASTRUCTURE TESTING SUITE]\n")
    term.brightBlack.bgWhite("Welcome\n\n")
    console.log("[*] Loading identity and creating a tx...")
    // TODO Make it .env-ized
    const our_identity = forge.pki.ed25519.generateKeyPair()
    const receiver_identity = forge.pki.ed25519.generateKeyPair()
    term.green("[+] Identity created\n")
    console.log("[*] Creating a transaction...")
    let tx = await createTransaction(
        1,
        "demoswork",
        our_identity.publicKey,
        receiver_identity.publicKey,
        "data",
        our_identity.privateKey,
    )
    term.green("[+] Transaction created\n")
    console.log(tx)
    term.green("[+] Transaction ready to be broadcasted\n")
    // TODO ^
}

async function createTransaction(
    value: number,
    txType: "web2Request" | "crosschainOperation" | "demoswork" | "NODE_ONLINE",
    sender: forge.pki.ed25519.BinaryBuffer,
    receiver: forge.pki.ed25519.BinaryBuffer,
    txData: any,
    signerKey: forge.pki.ed25519.BinaryBuffer,
): Promise<Transaction> {
    let tx: Transaction = new Transaction()
    // Create a tx
    tx.content.amount = value
    tx.content.from = sender
    tx.content.to = receiver
    tx.content.timestamp = Date.now()
    tx.content.transaction_fee = null // TODO Implement
    tx.content.type = txType
    tx.content.data = txData
    // Get our identity and sign the tx
    let signature_result = Transaction.sign(tx, signerKey)
    if (!signature_result[0]) throw new Error("Signature creation failed")
    tx.signature = signature_result[1]
    // Hashing the transaction too
    tx = Transaction.hash(tx)
    return tx
}

main()
