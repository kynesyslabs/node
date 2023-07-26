// TODO A function that based on the timestamp of the genesis block determines when we should start the consensus routine
import { time } from "console"
import Chain from "src/libs/blockchain/chain"
import sharedState from "src/utilities/sharedState"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

// INFO Checking if we need to start the consensus routine based on the timestamp of the genesis block
export async function checkConsensusTime(consensusPeriod: number = 10000): Promise<boolean> {
    let isConsensusTime = false
    let genesisBlock = await Chain.getGenesisBlock()
    genesisBlock = genesisBlock[0]
    let genesisTimestamp = genesisBlock.timestamp
    if (genesisTimestamp===null) genesisTimestamp = 0 // In case of unspecified genesis block timestamp
    // REVIEW Lets suppose a consensus period of 10 seconds
    let timePassed = sharedState.getInstance().getTimePassed(genesisTimestamp)
    // Checking if deltaTimestamp divided by consensusPeriod has no remainder (as it happens every consensusPeriod milliseconds)
    if (timePassed >= consensusPeriod) {
        console.log("[+] Time passed: "+timePassed)
        isConsensusTime = true
        sharedState.getInstance().setLastTimestamp() // Updating the timestamp
        
    }
    //console.log(isConsensusTime)
    // Returning the result
    return isConsensusTime
}

// INFO Helper function for the checkConsensusTime() function
export async function waitForConsensusTime(currentTimestamp: number = null): Promise<boolean> {
    while (!(await checkConsensusTime(currentTimestamp))) {
        await sleep(100)
    }
    console.log("Consensus time reached!")
    return true
}

