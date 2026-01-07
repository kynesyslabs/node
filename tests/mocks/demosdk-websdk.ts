export class Demos {
    rpc_url = ""
    connected = false

    async connectWallet(mnemonic: string, _options?: Record<string, unknown>): Promise<string> {
        this.connected = true
        void mnemonic
        return "0xmockwallet"
    }

    async rpcCall(_request: unknown, _authenticated = false): Promise<{
        result: number
        response: unknown
        require_reply: boolean
        extra: unknown
    }> {
        return {
            result: 200,
            response: "ok",
            require_reply: false,
            extra: null,
        }
    }
}

export const skeletons = {}
