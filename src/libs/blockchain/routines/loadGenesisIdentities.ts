import { getSharedState } from "@/utilities/sharedState"
import fs from "fs"
import log from "src/utilities/logger"
import { genesisFilePath } from "@/libs/blockchain/genesis/genesisFile"

const MIN_BALANCE = 1_000_000_000_000n

// Balances are compared as integers: a string compare ranks "9" above
// "1000000000000". An entry that is not an integer never qualifies.
function atLeastMinBalance(raw: unknown): boolean {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") return false
    try {
        return BigInt(raw) >= MIN_BALANCE
    } catch {
        return false
    }
}

export default async function loadGenesisIdentities() {
    const genesisData = JSON.parse(fs.readFileSync(genesisFilePath(), "utf8"))

    const identities = new Set<string>()
    for (const balance of genesisData.balances) {
        if (atLeastMinBalance(balance[1])) {
            identities.add(balance[0])
        }
    }

    log.info(`Genesis identities loaded: ${identities.size}`)
    getSharedState.genesisIdentities = identities
}
