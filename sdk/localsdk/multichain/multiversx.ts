/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import {
    Account,
    Address,
    Transaction,
    GasEstimator,
    TokenTransfer,
    TransferTransactionsFactory,
} from "@multiversx/sdk-core"

import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers"
import { Mnemonic, UserSigner, UserWallet } from "@multiversx/sdk-wallet"
import { INetworkProvider } from "@multiversx/sdk-network-providers/out/interface"

import required from "src/utilities/required"
import DefaultChainAsync from "./types/defaultChainAsync"

export default class MULTIVERSX extends DefaultChainAsync {
    declare provider: INetworkProvider
    declare wallet: UserSigner

    // TODO: Review the use of #private properties
    chainID: string

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
        this.chainID = chainID

        return this.connected
    }

    async disconnect() {
        this.wallet = null
        this.provider = null

        this.rpc_url = ""
        this.chainID = null
        this.connected = false
    }

    createWallet(password: string, addressIndex: number = undefined) {
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
        this.wallet = UserSigner.fromWallet(keyfile, password)

        return this.wallet
    }

    async getBalance(address: string): Promise<string> {
        required(address, "address is required to get the balance")

        const Iaddress = new Address(address)
        const account = await this.provider.getAccount(Iaddress)

        return account.balance.toString()
    }

    async pay(receiver: string, amount: string): Promise<Transaction> {
        required(this.provider, "Provider not connected")

        const senderAdress = this.wallet.getAddress()

        // INFO: Sync sender account which is needed to get a nonce
        const senderAccount = new Account(senderAdress)
        const senderOnNetwork = await this.provider.getAccount(senderAdress)
        senderAccount.update(senderOnNetwork)

        const receiverAdress = new Address(receiver)

        const gas = new GasEstimator()
        const factory = new TransferTransactionsFactory(gas)

        const transfer = TokenTransfer.egldFromAmount(amount)
        const tx = factory.createEGLDTransfer({
            sender: senderAdress,
            receiver: receiverAdress,
            value: transfer,
            chainID: this.chainID,
        })

        tx.setNonce(senderAccount.getNonceThenIncrement())

        // INFO: tx is an unsigned transaction
        // INFO: Return it for signing and broadcast
        return tx
    }

    info(): Promise<string> {
        throw new Error("Method not implemented.")
    }

    async signTransaction(transaction: Transaction): Promise<Transaction> {
        required(this.wallet, "Wallet not connected")

        const serializedTx = transaction.serializeForSigning()
        const signature = await this.wallet.sign(serializedTx)
        transaction.applySignature(signature)

        return transaction
    }

    async sendTransaction(signed_tx: Transaction) {
        required(this.provider, "Provider not connected")

        const tx_hash = await this.provider.sendTransaction(signed_tx)
        return tx_hash
    }
}
