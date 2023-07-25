
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/* INFO
 * Current capabilities: read from different chains (stored in the imported variable)
 * Support EVM and non EVM chains
 * TODO: Write on different chains, cross chain execution, evm smart contract tests
*/

// NOTE By importing ./sdk through sdk/index.ts we get all the initialized and iimplemented chains from demos sdk
import * as demosdk from "../sdk"
import * as fs from "fs"
import { ethers } from "ethers"

console.log(demosdk)

async function main() {

    // INFO EVM connection
    const chain_id = 5
    const evm_rpc = "https://rpc.ankr.com/eth_goerli"
    const evm = demosdk.EVM.createInstance(chain_id, evm_rpc)

    // INFO EVM Addresses and objects
    let contract_address = "0x2921449f72634a5b647b8e5d8756fe135f62b076"
    let contract_abi = fs.readFileSync("src/tests/chainscript/chainscript_example_abi.json", "utf-8")
    let contract_instance = new ethers.Contract(contract_address, contract_abi, evm.provider)

    // INFO Ripple Testnet credentials and connection
    let xrp_test_key_1 = "ss9QaGYDxi96NSSzFy8w3mv2JN4Sz"
    // let xrp_test_key_2 = "sahCwK3XZS6q5kuqqHc5XvKPDbmUo"
    let xrp_test_account_2 = "r9j6DZS1TEQoFNvry9UxR64dSREAfEgHPV"
    let ripple = new demosdk.XRPL()
    await ripple.connect("wss://s.altnet.rippletest.net:51233")
    await ripple.connectWallet(xrp_test_key_1)
    console.log("[*] Our ripple wallet is: ")
    console.log(ripple.wallet)

    // INFO Reading from ETH Goerli
    console.log("[*] Checking Smart Contract state...")
    let contract_state = await contract_instance.whichLight()
    console.log("[*] Contract state is: " + contract_state)

    // INFO Based on the read, we initiate or not the payment on XRPL
    let transferable = 10 // TODO Will be a status read on eth
    if (contract_state) {
        console.log("[*] We can initiate the payment on XRPL")
        await ripple.pay(xrp_test_account_2, transferable)
        console.log("[*] Payment on XRPL executed")
    } else {
        console.log("[*] We cannot initiate the payment on XRPL")
    }

}

main()