import { defaultRegistryTypes, GasPrice } from "@cosmjs/stargate"
import { decodeTxRaw, Registry } from "@cosmjs/proto-signing"

import ibcProviders from "sdk/localsdk/multichain/configs/ibcProviders"
import { IBC } from "sdk/localsdk/multichain"
import { getSampleTranfers, verifyNumberOrder } from "../utils"
import { wallets } from "../utils/wallets"

describe("IBC CHAIN TESTS", () => {
    let instance: IBC
    const chain_prefix = "cosmos"
    const token_denom = "uatom"
    const payment_options = { denom: token_denom }

    beforeAll(async () => {
        instance = await IBC.create(ibcProviders.cosmos.testnet)
        await instance.connectWallet(wallets.ibc.wallet, {
            prefix: chain_prefix,
            gasPrice: "0.012uatom",
        })

        expect(instance.connected).toBe(true)
    })

    test("preparePay returns a signed tx", async () => {
        const address = instance.getAddress()
        const tx_bytes = await instance.pay(
            address,
            "1",
            payment_options,
        )

        // INFO: Decode the bytes to get the raw tx
        // LINK: https://cosmos.github.io/cosmjs/latest/proto-signing/modules.html#decodeTxRaw
        // Ctrl + click decodeTxRaw to see the decoded raw Tx interface
        const raw_tx = decodeTxRaw(tx_bytes)
        expect(raw_tx.signatures.length == 1).toBe(true)
    })

    test("A tx is signed with the ledger nonce", async () => {
        const address = instance.getAddress()

        // INFO: Get the current ledger sequence
        const ledger_sequence = (await instance.provider.getAccount(address))
            ?.sequence

        // INFO: Sign and decode the tx
        const tx_bytes = await instance.pay(
            address,
            "1",
            payment_options,
        )
        const raw_tx = decodeTxRaw(tx_bytes)

        // INFO: Compare the sequences
        const tx_sequence = Number(raw_tx.authInfo.signerInfos[0].sequence)
        expect(tx_sequence).toEqual(ledger_sequence)
    })

    test("Transactions are signed with increasing nonces", async () => {
        const address = instance.getAddress()
        const payments = getSampleTranfers(address)
        const signed_txs = await instance.multiPay(payments, payment_options)

        // INFO: Get a list of objects containing the sequences
        const signer_infos = signed_txs.map(tx_bytes => {
            const tx = decodeTxRaw(tx_bytes)
            return tx.authInfo.signerInfos[0]
        })

        const is_sorted = verifyNumberOrder(signer_infos, "sequence")
        expect(is_sorted).toBe(true)
    })

    test("Transactions are signed in order of appearance", async () => {
        const address = instance.getAddress()
        const payments = getSampleTranfers(address)
        const signed_txs = await instance.multiPay(payments, payment_options)

        const amounts = signed_txs.map(tx_bytes => {
            const tx = decodeTxRaw(tx_bytes)

            // INFO: Decode the message to get the amount
            // LINK: https://cosmos.github.io/cosmjs/latest/proto-signing/classes/Registry.html
            const registry = new Registry(defaultRegistryTypes)
            const message = registry.decode(tx.body.messages[0])
            return message["amount"][0]
        })

        const is_sorted = verifyNumberOrder(amounts, "amount")
        expect(is_sorted).toBe(true)
    })
})
