
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
import * as demosdk from "./sdk"

console.log(demosdk)

async function main() {
    // NOTE Let's connect to two chains
    const evm = demosdk.EVM.createInstance(1, "https://rpc.ankr.com/eth")

    const xrpl = new demosdk.XRPL()
    xrpl.connect("wss://xrpl.ws/")


    // ANCHOR Experiments!

	// INFO Adjust this value > 1 to have an outcome on the other chain or < 1 to have another outcome
    let treshold_balance = 1.5

	// NOTE Let's set the accounts to read from during this example
    let ripple_outcome_1 = "rMQ98K56yXJbDGv49ZSmW51sLn94Xe1mu1"
    let ripple_outcome_2 = "rUeDDFNp2q7Ymvyv75hFGC8DAcygVyJbNF"
	let evm_address = "0x00000000219ab540356cbb839cbe05303d7705fa"

	// NOTE Preparing a variable to store the outcome
	let chosen_ripple_account: string

	// INFO Reading from ETH Mainnet
	console.log("Checking EVM balance...")
    let evm_balance_outcome = await evm.getBalance(evm_address)
	let evm_balance = parseFloat(evm_balance_outcome)
	console.log("EVM Balance is: " + evm_balance)

	// NOTE Calculating the treshold and the outcome
	let treshold = evm_balance * treshold_balance
	console.log("Treshold is: " + treshold)
    if ((evm_balance/2) < treshold) {
		chosen_ripple_account = ripple_outcome_1
		console.log("EVM balance is less than treshold, choosing account: " + chosen_ripple_account)
    } else {
		chosen_ripple_account = ripple_outcome_2
		console.log("EVM balance is greater than treshold, choosing account: " + chosen_ripple_account)
	}

	// INFO Reading from XRPL Mainnet based on the result of the ETH Mainnet data
	console.log("Getting XRPL balance...")
	let chosen_ripple_balance = await xrpl.getBalance(chosen_ripple_account, false)
	console.log("Balance of chosen account: " + chosen_ripple_balance)
}

main()