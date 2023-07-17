import chains from "./crosschain_support"

async function main() {
    // Ethereum
    const eth_rpc = "http://eth.bandal.one:8545"
    const eth_address = "0x815eC3F291079Dd9dd7237f60ff0c8e70aEAf690"

    const eth_provider = await chains.evm.connect(eth_rpc)
    const eth_balance = await chains.evm.getBalance(eth_address)

    console.log(`Ethereum balance of ${eth_address}: ${eth_balance}`)

    // Bitcoin
    const btc_rpc = "http://144.178.132.34:8333"
    const btc_address = "16ftSEQ4ctQFDtVZiUBusQUjRrGhM3JYwe"

    const btc_provider = await chains.btc.connect(btc_rpc)
    const btc_balance = await chains.btc.getBalance(btc_address)

    console.log(`Bitcoin balance of ${btc_address}: ${btc_balance}`)

    // Solana
    
    const sol_rpc = "https://api.mainnet-beta.solana.com"
    const sol_address = "CnP33htGVwKHF4psPq57QnRpiNTgKW58RyceytoX78n2"

    const sol_provider = await chains.solana.connect(sol_rpc)
    const sol_balance = await chains.solana.getBalance(sol_address)

    console.log(`Solana balance of ${sol_address}: ${sol_balance}`)
    
}

main().catch(console.error)