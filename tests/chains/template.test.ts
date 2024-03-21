// INFO: Duplicate and rename this file to add a new XM test
import chainProviders from "$lib/chainProviders"
// import { CHAIN } from '$lib/demos_libs/xmlibs/multichain';

describe("<CHAIN_NAME> CHAIN TESTS", () => {
	// TODO: Set correct instance type
	let instance: any

	beforeAll(async () => {
		// INFO: Connect the RPC and Wallet here
		// instance = await CHAIN.create(chainProviders.ibc.testnet);
		await instance.connect()
		await instance.connectWallet("<wallet>")

		expect(instance.connected).toBe(true)
	})

	afterAll(async () => {
		// INFO: Disconnect from the RPC here
		// NOTE: Not needed for non web socket RPCs
		await instance.disconnect()
	})

	test("preparePay returns a signed tx", async () => {
		// TODO: Test code here
	})
	test("A tx is signed with the ledger nonce", async () => {
		// TODO: Test code here
	})

	test("Transactions are signed with increasing nonces", async () => {
		// TODO: Test code here
	})
	test("Transactions are signed in order of appearance", async () => {
		// TODO: Test code here
	})
})
