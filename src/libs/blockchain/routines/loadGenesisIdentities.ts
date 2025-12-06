import { getSharedState } from "@/utilities/sharedState"
import fs from "fs"

const MIN_BALANCE = "1000000000000"

export default async function loadGenesisIdentities() {
    const genesisData = JSON.parse(fs.readFileSync("data/genesis.json", "utf8"))

    const identities = new Set<string>()
    for (const balance of genesisData.balances) {
        if (balance[1] >= MIN_BALANCE) {
            identities.add(balance[0])
        }
    }

    console.log("Genesis identities loaded: " + identities.size)
    getSharedState.genesisIdentities = identities
}
