import termkit from "terminal-kit"

import MULTIVERSX from "../multiversx"

const term = termkit.terminal
const TESTNET_URL = "https://testnet-api.multiversx.com"
const VALID_TESTNET_ADDRESS =
    "erd1fsac7hpfzyhzs2ls894579kctfzp8n3hyp6gt5n0ccnd6hp9dpkqd6hg6w"

export default async function testMultiversx() {
    const WALLET_PASSWORD = "password"

    const multiversx = new MULTIVERSX(TESTNET_URL)

    // Connecting to the network
    console.log("starting connection")
    await multiversx.connect()

    // Generating a wallet
    const { wallet_keyfile, address } = multiversx.createWallet(WALLET_PASSWORD)

    // Connecting to the wallet
    multiversx.connectWallet(wallet_keyfile, WALLET_PASSWORD)
    console.log(multiversx.wallet)

    // Checking if the connection points to the same wallet
    const is_same_wallet = multiversx.wallet.toJSON().bech32 === address

    term.bgCyan("Wallet created and connected: " + is_same_wallet + "\n")

    // Getting the balance
    const balance = await multiversx.getBalance(VALID_TESTNET_ADDRESS)
    console.log("Balance: " + balance)
}
