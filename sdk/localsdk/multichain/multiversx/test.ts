import MULTIVERSX from "../multiversx"

const TESTNET_URL = "https://testnet-api.multiversx.com"

export default async function testMultiversx() {
    const multiversx = new MULTIVERSX(TESTNET_URL)

    // Connecting to the network
    console.log("starting connection")
    await multiversx.connect()
    console.log(multiversx)

    // Generating a wallet
    const wallet = multiversx.createWallet("password")
    console.log(wallet)
}
