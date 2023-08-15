// INFO This singleton is used to store the state of the application through different parts of the application.

import * as forge from "node-forge"

export default class sharedState {
    private static instance: sharedState

    currentTimestamp: number = 0
    lastTimestamp: number = 0

    // SECTION shared state variables
    runMainLoop: boolean = true
    mainLoopPaused: boolean = false
    consensusMode: boolean = false
    serverPort: number = 53550
    rpcFee: number = 0
    publicKey: forge.pki.ed25519.BinaryBuffer
    privateKey: forge.pki.ed25519.BinaryBuffer
    
    // !SECTION shared state variables

    constructor() {
		
    }

    public static getInstance(): sharedState {
        if (!sharedState.instance) {
            sharedState.instance = new sharedState()
        }
        return sharedState.instance
    }

    // INFO Set the current timestamp as the last
    public setLastTimestamp() {
        this.lastTimestamp = this.currentTimestamp
    }

    // INFO Get the timestamp now
    public getTimestamp(): number {
        this.currentTimestamp = Date.now()
        return this.currentTimestamp
    }

    public getTimePassed(genesisTimestamp: number): number {
        this.getTimestamp()
        return this.currentTimestamp - this.lastTimestamp + genesisTimestamp // Take into account the genesis timestamp
    }

}