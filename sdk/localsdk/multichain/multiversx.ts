/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers"
import { INetworkProvider } from "@multiversx/sdk-network-providers/out/interface"

import DefaultChain from "./types/defaultChain"

export default class MULTIVERSX extends DefaultChain {
    declare provider: INetworkProvider

    constructor(rpcURL: string) {
        super(rpcURL)
        this.name = "multiversx"
    }

    connect(rpc_url: string): boolean {
        this.provider = new ProxyNetworkProvider(rpc_url)

        // INFO To check for connectivity, we need to await the networkConfig (but that would need rewriting the interface and how it is used)

        // const networkConfig = await this.provider.getNetworkConfig()
        // this.connected = networkConfig.ChainID !== undefined

        return true
    }

    disconnect(): void {
        throw new Error("Method not implemented.")
    }

    createWallet(): any {}

    connectWallet(privateKey: string) {
        throw new Error("Method not implemented.")
    }
    getBalance(address: string): Promise<string> {
        throw new Error("Method not implemented.")
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
