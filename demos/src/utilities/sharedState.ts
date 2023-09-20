// INFO This singleton is used to store the state of the application through different parts of the application.

import * as forge from "node-forge"
require("dotenv").config({path: "../../.commons" })
import Cryptography from "src/libs/crypto/cryptography"
import { Identity } from "src/libs/identity"

export default class sharedState {
    private static instance: sharedState

    currentTimestamp: number = 0
    lastTimestamp: number = 0
    identity: Identity

    // SECTION shared state variables
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false
    serverPort: number = 53550

    // SECTION shared useful variables
    rpcFee: number = 0 // TODO Implement
    publicKey: forge.pki.ed25519.BinaryBuffer // TODO Implement
    privateKey: forge.pki.ed25519.BinaryBuffer // TODO Implement

    // !SECTION shared state variables

    constructor() {
    }

    public static getInstance(): sharedState {
        if (!sharedState.instance) {
            sharedState.instance = new sharedState()
        }
        return sharedState.instance
    }

    public getTimePassed(genesisTimestamp: number): number {
        this.currentTimestamp = Date.now()
        let delta = this.currentTimestamp - this.lastTimestamp
        this.lastTimestamp = this.currentTimestamp // FIXME This must be the last block timestamp
        return delta
    }

    // ANCHOR Dynamic configurations (customizable in .commons)

    // INFO How many ms for each check of the consensus loop
    public getConsensusCheckStep(): number {
        return Number(process.env.CONSENSUS_CHECK_INTERVAL)
    }

    public getConsensusTime(): number {
        return Number(process.env.CONSENSUS_TIME)
    }

}