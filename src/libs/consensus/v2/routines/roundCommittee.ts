import { Peer } from "src/libs/peer"
import SecretaryManager from "../types/secretaryManager"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import getShard from "./getShard"

export interface RoundCommittee {
    members: Peer[]
    seed: string
    frozen: boolean
}

/** Committee for the next block: the running round's shard, else a fresh draw. */
export default async function getRoundCommittee(): Promise<RoundCommittee> {
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()
    const running = SecretaryManager.runningShard()
    if (running) {
        return { members: running, seed: commonValidatorSeed, frozen: true }
    }
    return {
        members: await getShard(commonValidatorSeed, lastBlockNumber),
        seed: commonValidatorSeed,
        frozen: false,
    }
}
