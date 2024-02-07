/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { Mnemonic, UserWallet } from "@multiversx/sdk-wallet"
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers"

import { UserAddress } from "@multiversx/sdk-wallet/out/userAddress"
import { INetworkProvider } from "@multiversx/sdk-network-providers/out/interface"

import required from "src/utilities/required"
import DefaultChainAsync from "./types/defaultChainAsync"

export default class MULTIVERSX extends DefaultChainAsync {
    declare provider: INetworkProvider
    declare wallet: UserWallet

    constructor(rpcURL: string) {
        super(rpcURL)
        this.name = "multiversx"
    }

    async connect(rpc_url: string = this.rpc_url) {
        // NOTE We might not need to pass the rpc_url to the provider as it's already set in the constructor

        this.provider = new ProxyNetworkProvider(this.rpc_url)

        const networkConfig = await this.provider.getNetworkConfig()
        this.connected = networkConfig.ChainID !== undefined

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

        console.log(wallet.toJSON())

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
        // NOTE: privateKey is the keyfile in a JSON string format
        // NOTE: the password param is not defined in DefaultChainAsync

        required(privateKey, "Key file is required to connect to the wallet.")
        required(password, "Password is required to decrypt the key file.")

        const keyfile = JSON.parse(privateKey)

        const secretKey = UserWallet.decryptSecretKey(keyfile, password)
        this.wallet = UserWallet.fromSecretKey({ secretKey, password })

        return this.wallet
    }

    async getBalance(address: string): Promise<string> {
        required(address, "address is required to get the balance")

        const Iaddress = UserAddress.fromBech32(address)
        const account = await this.provider.getAccount(Iaddress)

        return account.balance.toString()
    }

    pay(receiver: string, amount: string): Promise<any> {
        throw new Error("Method not implemented.")
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
