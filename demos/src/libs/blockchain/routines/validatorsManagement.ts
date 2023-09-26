// INFO This class exposes methods and types relative to the entrance and management of validators on chain

import Transaction from "../transaction"
import * as forge from "node-forge"
import GLS from "../gls/gls"

let MIN_TO_STAKE = 10000000000000000000000000 // TODO Defined in genesis

export default class validatorsManagement {

    constructor() {
		
    }

    static async manageValidatorEntranceTx(tx: Transaction): Promise<boolean> {
        let isEntranceValid = true
        // NOTE Validators success requirements below
        // Amount of staking
        if (tx.content.amount < MIN_TO_STAKE) {
            isEntranceValid	= false
        }
        // TODO Is not already staking
        // TODO Is not in the chain blacklist
        // TODO Has never been kicked from the chain
        return isEntranceValid
    }

    // REVIEW This should work but needs confirmations
    static async manageValidatorOnlineStatus(publicKey: forge.pki.ed25519.BinaryBuffer) {
        let hexKey = publicKey.toString("hex")
        let validator = await GLS.getGLSValidatorStatus(hexKey)
        let connectionString = validator["connection_string"]
        // TODO connection test
    }

    static async isValidatorActive(publicKey: forge.pki.ed25519.BinaryBuffer) {
        let hexKey = publicKey.toString("hex")
        let validator = await GLS.getGLSValidatorStatus(hexKey)
        // 2 means valid
        return (Number(validator["status"])===2)
    }
}