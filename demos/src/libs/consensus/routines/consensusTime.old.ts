// TODO A function that based on the timestamp of the genesis block determines when we should start the consensus routine
import { time } from "console"
import Chain from "src/libs/blockchain/chain"
import sharedState from "src/utilities/sharedState"

let step = sharedState.getInstance().getConsensusCheckStep()

// INFO Checking if we need to start the consensus routine based on the timestamp of the genesis block
export async function checkConsensusTime(consensusPeriod: number = 10000): Promise<boolean> {
    let isConsensusTime = false
    // TODO Stuff
    return isConsensusTime
}

// INFO Helper function for the checkConsensusTime() function
export async function waitForConsensusTime(currentTimestamp: number = null): Promise<boolean> {
    while (!(await checkConsensusTime(currentTimestamp))) {
        await sleep(step)
    }
    console.log("Consensus time reached!")
    return true
}


async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}
