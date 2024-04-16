import required from "src/utilities/required"

/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import {
    Account, Address, GasEstimator, IPlainTransactionObject, TokenTransfer, Transaction,
    TransferTransactionsFactory,
} from "@multiversx/sdk-core"
import { ApiNetworkProvider } from "@multiversx/sdk-network-providers"
import { INetworkProvider } from "@multiversx/sdk-network-providers/out/interface"
import { Mnemonic, UserSigner, UserWallet } from "@multiversx/sdk-wallet"

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

    async connect(rpc_url?: string) {
        // NOTE We might not need to pass the rpc_url to the provider as it's already set in the constructor

        if (rpc_url) {
            this.rpc_url = rpc_url
        }

        this.provider = new ApiNetworkProvider(this.rpc_url, {
            timeout: 10000,
        })

        const networkConfig = await this.provider.getNetworkConfig()
        // NOTE: Chain ID is needed in this.pay()
        this.chainID = networkConfig.ChainID
        this.connected = Boolean(this.chainID)

        return this.connected
    }

    static async create(rpc_url?: string) {
        const instance = new MULTIVERSX(rpc_url)

        if (!rpc_url) {
            return instance
        }

        await instance.connect()
        return instance
    }

    async disconnect() {
        this.resetLocals()
        this.chainID = null
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

    // @ts-ignore
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

        // INFO: Gas estimation
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

        // INFO: tx is the unsigned transaction
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

    async sendTransaction(raw_tx: Transaction | IPlainTransactionObject) {
        required(this.provider, "Provider not connected")
        let signed_tx: Transaction

        // INFO: raw_tx is a plain object when it comes from the frontend
        if (!(raw_tx instanceof Transaction)) {
            signed_tx = Transaction.fromPlainObject(raw_tx)
        } else {
            signed_tx = raw_tx
        }

        // INFO: The provider can also send a list of transactions
        const tx_hash = await this.provider.sendTransaction(
            signed_tx as Transaction,
        )

        return {
            result: "success",
            hash: tx_hash,
        }
    }

    async signTransactions(raw_tx: any[], options?: {}): Promise<any> {
        throw new Error("Method not implemented.")
    }
}
