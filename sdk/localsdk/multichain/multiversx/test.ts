import MULTIVERSX from "../multiversx"

const TESTNET_URL = "https://testnet-api.multiversx.com"

export default async function testMultiversx() {
    const multiversx = new MULTIVERSX(TESTNET_URL)
    console.log(multiversx)
}
