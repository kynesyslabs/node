import { readFile } from "fs/promises"
import { resolve } from "path"
import { Demos } from "@kynesyslabs/demosdk/websdk"

const DEFAULT_NODE_URL = process.env.DEMOS_NODE_URL || "https://node2.demos.sh"
const IDENTITY_FILE = process.env.IDENTITY_FILE || resolve(".demos_identity")

async function main() {
    const mnemonic = (await readFile(IDENTITY_FILE, "utf8")).trim()
    if (!mnemonic) {
        throw new Error(`Mnemonic not found in ${IDENTITY_FILE}`)
    }

    const demos = new Demos()
    demos.rpc_url = DEFAULT_NODE_URL
    demos.connected = true

    const address = await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
    console.log("Connected wallet:", address)

    const response = await demos.rpcCall({ method: "ping", params: [] }, true)
    console.log("Ping response:", response)
}

main().catch(error => {
    console.error("Failed to execute authenticated ping via Demos SDK:", error)
    process.exitCode = 1
})
