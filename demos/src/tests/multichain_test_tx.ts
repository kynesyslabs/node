import chains from "../features/multichain/crosschain_support" // update this with your actual file path
import { ethers } from "ethers"
import Provider from "ethers"


async function test() {
    // Ethereum transaction parameters
    const evmRpc = "http://eth.bandal.one:8545"
    const evmPrivateKey = "YOUR_PRIVATE_KEY"
    const evmTransaction: ethers.TransactionRequest = {
        to: "RECIPIENT_ETH_ADDRESS",
        value: 1000000,
    }

    // Bitcoin transaction parameters
    const btcRpc = "https://api.blockcypher.com/v1/btc/main"
    const btcPrivateKey = "YOUR_PRIVATE_KEY"
    const btcTransaction = {
        from: "SENDER_BTC_ADDRESS",
        to: "RECIPIENT_BTC_ADDRESS",
        value: 1000000, // amount in Satoshis (0.01 BTC)
        privateKey: btcPrivateKey,
    }

    try {
        // Testing EVM transaction
        const eth_provider = new Provider.JsonRpcProvider(evmRpc)
        const evmWallet = new ethers.Wallet(evmPrivateKey, eth_provider)
        const evmTxResponse = await evmWallet.sendTransaction(evmTransaction)
        console.log(`EVM transaction hash: ${evmTxResponse.hash}`)

        // Testing BTC transaction
        await chains.btc.connect(btcRpc)
        const btcTxHash = await chains.btc.sendTransaction(btcTransaction)
        console.log(`BTC transaction hash: ${btcTxHash}`)
    } catch (error) {
        console.error(`Error executing transaction: ${error.message}`)
    }
}

test()
