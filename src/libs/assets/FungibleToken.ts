// INFO Basic extensible fungible token implementation. Can be extended in custom applications but must be used as a base class.

import forge from "node-forge"

import { hashing } from "../crypto"
import Cryptography from "../crypto/cryptography"

export default class FungibleToken {
    public metadata: {
        tokenType: string
        tokenName: string
        symbol: string
        decimals: number
        totalSupply: string
        creation_timestamp: number
        deployment_timestamp: number

        // Specific properties that must be always present in a fungible token
        mintable: boolean
        owners: string[] // DEMOS Addresses in hex format
        balances: Map<string, number> // DEMOS Address -> balance

        // TODO Add other properties specific to your fungible token here
    }
    public address: string
    public deploymentSignature: string

    // TODO We can either create a new token or load an existing one
    static async getToken(tokenAddress: string): Promise<FungibleToken> {
        const token = new FungibleToken()
        // TODO Load the token from the gcr table if any and give back an instance of this class
        return token
    }

    // INFO Creating a new class, off chain. This will be written to the gcr table once deployed and approved.
    static async createNewToken(
        tokenName: string,
        symbol: string,
        decimals: number,
        creator: string, // Hex address
    ): Promise<FungibleToken> {
        const token = new FungibleToken()
        token.metadata.tokenName = tokenName
        token.metadata.symbol = symbol
        token.metadata.decimals = decimals
        token.metadata.mintable = true
        token.metadata.owners = [creator]
        token.metadata.balances = new Map<string, number>()
        token.metadata.creation_timestamp = Date.now()
        return token
    }

    // Injection support here
     
    private _transfer: Function = null


    // SECTION Smart contract logic hooks

    // INFO Calling this method is the right way to decide your transfer logic.
    // Implement anything as _transfer and it will be executed prior to the actual transfer.
     
    hookTransfer(transfer: Function) {
        this._transfer = transfer
    }

    // SECTION Smart contract logic endpoints

    // INFO This method is the one that should be called to transfer tokens. By the usage of hookTransfer you can decide what to do before the actual transfer.
    transfer(sender: string, receiver: string, amount: number) {
        if (this._transfer) {
            this._transfer()
        }
        // TODO Check on balances
        // TODO Actual transfer
    }

    // SECTION Management methods for developers

    // INFO Deploying on chain is an internal operation
    async deploy(deploymentKey: forge.pki.ed25519.NativeBuffer): Promise<void> {
        // Closing the token metadata
        this.metadata.deployment_timestamp = Date.now()
        const hashedTokenMetadata = hashing.sha256(JSON.stringify(this.metadata)) // NOTE This is also the token address
        this.address = hashedTokenMetadata
        // Signing the token metadata
        const signature = Cryptography.sign(
            hashedTokenMetadata,
            deploymentKey,
        ).toString("hex")
        this.deploymentSignature = signature
        // TODO Deploy the token on chain
    }
}
