import XRPL from '../features/multichain/xrpl'


// Testnet credentials
let address = "r9j6DZS1TEQoFNvry9UxR64dSREAfEgHPV"
let seed_1 = "ss9QaGYDxi96NSSzFy8w3mv2JN4Sz"
let seed_2 = "sahCwK3XZS6q5kuqqHc5XvKPDbmUo"

let rpc = "wss://s.altnet.rippletest.net:51233"

async function main() {
	let ripple = new XRPL()
	await ripple.connect(rpc)
	await ripple.connectWallet(seed_1);
	console.log("[*] Our wallet is: ")
	console.log(ripple.wallet)

	let xrp_balance_1 = await ripple.getBalance(ripple.wallet.address, false)
	let xrp_balance_2 = await ripple.getBalance(address, false)

	console.log("=== PRE TX BALANCES ===")
	console.log(xrp_balance_1)
	console.log(xrp_balance_2)
	console.log("=== PRE TX BALANCES ===")

	let xrp_balance = await ripple.getBalance(address, false)
	console.log(xrp_balance)
	console.log("[*] Account info for " + address + ":")
	let info = await ripple.accountInfo(address)
	console.log(info)

	console.log("[*] Trying to send...")
	let payTX = await ripple.pay(address, 10)
	console.log(payTX)

	xrp_balance_1 = await ripple.getBalance(ripple.wallet.address, false)
	xrp_balance_2 = await ripple.getBalance(address, false)

	console.log("=== POST TX BALANCES ===")
	console.log(xrp_balance_1)
	console.log(xrp_balance_2)
	console.log("=== POST TX BALANCES ===")
	
	console.log("[+] Test completed.")
}

main()