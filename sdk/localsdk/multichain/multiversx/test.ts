import path from "path"
import fs from "node:fs/promises"
import { fileURLToPath } from "url"

import MULTIVERSX from "../multiversx"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TESTNET_URL = "https://testnet-api.multiversx.com"
const VALID_TESTNET_ADDRESS =
    "erd1fsac7hpfzyhzs2ls894579kctfzp8n3hyp6gt5n0ccnd6hp9dpkqd6hg6w"

async function readKeyfileFromPath(_path: string) {
    const fullpath = path.join(__dirname, _path)

    // INFO: Read the keyfile from the path
    const file = await fs.readFile(fullpath, {
        encoding: "utf-8",
    })

    return file.trim()
}

export default async function testMultiversx() {
    const WALLET_PASSWORD = "password"

    const multiversx = new MULTIVERSX(TESTNET_URL)

    // INFO: Connecting to the network
    console.log("starting connection")
    await multiversx.connect()

    // INFO: Generating a wallet
    const { wallet_keyfile, address } = multiversx.createWallet(WALLET_PASSWORD)
    console.log("[MULTIVERSX] GENERATED KEY FILE")
    console.log(wallet_keyfile)

    // INFO: Connecting to the wallet
    const VALID_KEYFILE = await readKeyfileFromPath("keyfile.json")
    const VALID_KEYFILE_PASSWORD = await readKeyfileFromPath(
        "keyfile_password.txt",
    )

    multiversx.connectWallet(VALID_KEYFILE, VALID_KEYFILE_PASSWORD)

    // INFO: Getting the balance
    const balance = await multiversx.getBalance(VALID_TESTNET_ADDRESS)
    console.log("Balance: " + balance)

    // INFO: ESDT Transfer
    const tx = await multiversx.pay(address, "1.5")
    console.log(tx)
}
