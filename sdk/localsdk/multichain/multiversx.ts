/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import {
    Account,
    Transaction,
    TokenTransfer,
    TransactionPayload,
} from "@multiversx/sdk-core"
import { Mnemonic, UserWallet, UserWalletKind } from "@multiversx/sdk-wallet"
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers"

import { UserAddress } from "@multiversx/sdk-wallet/out/userAddress"
import { INetworkProvider } from "@multiversx/sdk-network-providers/out/interface"

import required from "src/utilities/required"
import DefaultChainAsync from "./types/defaultChainAsync"

export default class MULTIVERSX extends DefaultChainAsync {
    declare provider: INetworkProvider
    declare wallet: UserWallet

    // TODO: Review the use of #private properties
    #chainID: string
    #walletPubKeybech32: string

    constructor(rpcURL: string) {
        super(rpcURL)
        this.name = "multiversx"
    }

    async connect(rpc_url: string = this.rpc_url) {
        // NOTE We might not need to pass the rpc_url to the provider as it's already set in the constructor

        this.provider = new ProxyNetworkProvider(this.rpc_url)

        const networkConfig = await this.provider.getNetworkConfig()
        const chainID = networkConfig.ChainID

        // NOTE: Chain ID is needed in this.pay()
        this.connected = chainID !== undefined
        this.#chainID = chainID

        return this.connected
    }

    async disconnect() {
        // TODO: implement this
        throw new Error("Method not implemented.")
    }

    createWallet(password: string, addressIndex: number = 0) {
        required(password, "Password is required to encrypt the key file")

        const mnemonics = Mnemonic.generate()

        const words = mnemonics.getWords()
        const words_with_index = words.map((word, index) => index + ". " + word)

        const secretKey = mnemonics.deriveKey(addressIndex, password)
        const wallet = UserWallet.fromSecretKey({ secretKey, password })

        const jsonWallet = wallet.toJSON()

        // NOTE: .bech32 is the address property
        const walletAddress: string = jsonWallet.bech32

        // TODO Return downloadable mnemonics & json files
        return {
            mnemonics: words,
            address: walletAddress,
            mnemonics_txt: words_with_index.join(""),
            wallet_keyfile: JSON.stringify(jsonWallet, null, 2),
        }
    }

    connectWallet(privateKey: string, password: string) {
        // NOTE: privateKey is the keyFile in a JSON string format
        // NOTE: the password param is not yet defined in DefaultChainAsync

        required(privateKey, "KeyFile is required to connect to the wallet.")
        required(password, "Password is required to decrypt the key file.")

        const keyfile = JSON.parse(privateKey)

        switch (keyfile.kind) {
            case UserWalletKind.Mnemonic:
                const mnemonic = UserWallet.decryptMnemonic(keyfile, password)
                this.wallet = UserWallet.fromMnemonic({
                    mnemonic: mnemonic.toString(),
                    password,
                })

                const key = mnemonic.deriveKey()
                this.#walletPubKeybech32 = key
                    .generatePublicKey()
                    .toAddress()
                    .bech32()
                break

            case UserWalletKind.SecretKey:
                const secretKey = UserWallet.decryptSecretKey(keyfile, password)
                this.wallet = UserWallet.fromSecretKey({ secretKey, password })
                this.#walletPubKeybech32 = this.wallet.toJSON().bech32

                break

            default:
                throw new Error("MULTIVERSX: Invalid KeyFile")
        }

        return this.wallet
    }

    async getBalance(address: string): Promise<string> {
        required(address, "address is required to get the balance")

        const Iaddress = UserAddress.fromBech32(address)
        const account = await this.provider.getAccount(Iaddress)

        return account.balance.toString()
    }

    async pay(receiver: string, amount: string): Promise<Transaction> {
        // NOTE: provider is required here because we need the Chain ID which is resolved in this.connect()

        required(this.provider, "Provider not connected")
        required(this.#walletPubKeybech32, "Wallet is not connected")

        const senderAdress = UserAddress.fromBech32(this.#walletPubKeybech32)

        // INFO: Sync sender account which is needed to get a nonce
        const senderAccount = new Account(senderAdress)
        const senderOnNetwork = await this.provider.getAccount(senderAdress)
        senderAccount.update(senderOnNetwork)

        const receiverAdress = UserAddress.fromBech32(receiver)

        const transfer = TokenTransfer.egldFromAmount(amount)

        const tx = new Transaction({
            // data: new TransactionPayload(""),
            gasLimit: 80000,
            sender: senderAdress,
            receiver: receiverAdress,
            value: transfer,
            chainID: this.#chainID,
        })

        tx.setNonce(senderAccount.getNonceThenIncrement())

        // INFO: Return for signing and broadcast
        return tx
    }

    info(): Promise<string> {
        throw new Error("Method not implemented.")
    }

    async signTransaction(raw_transaction: any): Promise<any> {
        // TODO
    }

    sendTransaction(transactions: any) {
        throw new Error("Method not implemented.")
    }
}
