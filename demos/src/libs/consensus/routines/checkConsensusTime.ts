// TODO A function that based on the timestamp of the genesis block determines when we should start the consensus routine
import Chain from "src/libs/blockchain/chain"

export default async function checkConsensusTime(): Promise<boolean> {
    let isConsensusTime = false
    let genesisBlock = await Chain.getGenesisBlock()
    // TODO See how it returns and fill a Block object or retrieve the needed info
    // WARN Here we are assuming the genesisBlock structure: see the above todo
    let genesisTimestamp = genesisBlock.timestamp
    // REVIEW Lets suppose a consensus period of 10 seconds
    let consensusPeriod = 10000 // in ms
    let currentTimestamp = new Date().getTime()
    let deltaTimestamp = currentTimestamp - genesisTimestamp
    // Checking if deltaTimestamp divided by consensusPeriod has no remainder (as it happens every consensusPeriod milliseconds)
    if (deltaTimestamp % consensusPeriod === 0) {
        isConsensusTime = true
    }
    // Returning the result
    return isConsensusTime
}