// INFO This class exposes methods and types relative to the entrance and management of validators on chain

import forge from "node-forge"

import GCR from "../gcr/gcr"
import Transaction from "../transaction"

const minToStake = 10000000000000000000000000 // TODO Defined in genesis

export default class ValidatorsManagement {
    constructor() {}

    static async manageValidatorEntranceTx(tx: Transaction): Promise<boolean> {
        let isEntranceValid = true
        // NOTE Validators success requirements below
        // Amount of staking
        if (tx.content.amount < minToStake) {
            isEntranceValid = false
        }
        // TODO Is not already staking
        // TODO Is not in the chain blacklist
        // TODO Has never been kicked from the chain
        return isEntranceValid
    }

    // REVIEW This should work but needs confirmations
    static async manageValidatorOnlineStatus(
        publicKey: forge.pki.ed25519.BinaryBuffer,
    ) {
        const hexKey = publicKey.toString("hex")
        const validator = await GCR.getGCRValidatorStatus(hexKey)
        const connectionString = validator["connection_string"]
        // TODO connection test
    }

    static async isValidatorActive(publicKey: forge.pki.ed25519.BinaryBuffer) {
        const hexKey = publicKey.toString("hex")
        const validator = await GCR.getGCRValidatorStatus(hexKey)
        // 2 means valid
        return Number(validator["status"]) === 2
    }
}
