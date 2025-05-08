import Web3, { HttpProvider } from "web3"
import {
    SDK,
    Configuration,
    BLOCKCHAIN_NAME,
    CHAIN_TYPE,
    WrappedCrossChainTrade,
    CrossChainTrade,
    SwapTransactionOptions,
    RubicSdkError,
    BasicTransactionOptions,
    SolanaWalletProviderCore,
    SolanaWeb3,
} from "rubic-sdk"
import {
    BridgeTradePayload,
    SupportedTokens,
    ChainProviders,
} from "@kynesyslabs/demosdk/types"
import {
    BlockchainName,
    BRIDGE_PROTOCOLS,
    ExtendedCrossChainManagerCalculationOptions,
} from "./bridgeUtils"
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { Signer } from "@solana/web3.js"

// TODO: Need to use mock Private keys for now then remove mock data and use real data
const mockSolanaPrivateKey =
    ""
const mockEvmPrivateKey =
    ""

class CustomEVMProvider {
    private httpProvider: HttpProvider
    private eventHandlers: Record<string, Function[]> = {}
    private signer: any

    constructor(httpProvider: HttpProvider, signer: any) {
        this.httpProvider = httpProvider
        this.signer = signer
    }

    send(
        payload: any,
        callback: (error: Error | null, result?: any) => void,
    ): void {
        if (payload.method === "eth_sendTransaction") {
            const txParams = payload.params[0]

            const minPriorityFee = Web3.utils.toWei("25", "gwei")
            if (
                !txParams.maxPriorityFeePerGas ||
                BigInt(txParams.maxPriorityFeePerGas) < BigInt(minPriorityFee)
            ) {
                txParams.maxPriorityFeePerGas = minPriorityFee
            }

            if (
                !txParams.maxFeePerGas ||
                BigInt(txParams.maxFeePerGas) <
                    BigInt(txParams.maxPriorityFeePerGas)
            ) {
                txParams.maxFeePerGas = Web3.utils.toWei("100", "gwei")
            }

            this.signer
                .signTransaction(txParams)
                .then((signedTx: any) => {
                    const newPayload = {
                        jsonrpc: payload.jsonrpc,
                        id: payload.id,
                        method: "eth_sendRawTransaction",
                        params: [signedTx.rawTransaction],
                    }
                    this.httpProvider.send(newPayload, callback)
                })
                .catch(callback)
        } else {
            this.httpProvider.send(payload, callback)
        }
    }

    disconnect(): void {
        // No-op implementation - HTTP providers don't need disconnection
        console.log("Disconnect called (no-op for HTTP provider)")
    }

    // Event emitter methods
    on(type: string, callback: Function): void {
        if (!this.eventHandlers[type]) {
            this.eventHandlers[type] = []
        }
        this.eventHandlers[type].push(callback)
        console.log(`Registered event handler for ${type}`)
    }

    removeListener(type: string, callback: Function): void {
        if (!this.eventHandlers[type]) return
        this.eventHandlers[type] = this.eventHandlers[type].filter(
            handler => handler !== callback,
        )
        console.log(`Removed event handler for ${type}`)
    }

    sendAsync(
        payload: any,
        callback: (error: Error | null, result?: any) => void,
    ): void {
        this.send(payload, callback)
    }

    request(args: any): Promise<any> {
        return new Promise((resolve, reject) => {
            this.send(
                {
                    jsonrpc: "2.0",
                    id: Date.now(),
                    method: args.method,
                    params: args.params,
                },
                (error, response) => {
                    if (error) {
                        reject(error)
                    } else if (
                        !response ||
                        typeof response.result === "undefined"
                    ) {
                        reject(
                            new Error(
                                `Invalid response for ${
                                    args.method
                                }: ${JSON.stringify(response)}`,
                            ),
                        )
                    } else {
                        resolve(response.result)
                    }
                },
            )
        })
    }
}

class CustomSolanaProvider implements SolanaWalletProviderCore {
    private connection: Connection
    private signer: Keypair
    publicKey: PublicKey
    core: SolanaWeb3
    address: string

    constructor(rpcUrl: string, privateKey: string) {
        this.connection = new Connection(rpcUrl, "confirmed")

        let secretKey: Uint8Array
        if (privateKey.startsWith("[") || privateKey.startsWith("{")) {
            secretKey = Uint8Array.from(JSON.parse(privateKey))
        } else {
            secretKey = bs58.decode(privateKey)
        }
        if (secretKey.length !== 64) {
            throw new Error(
                "Invalid Solana private key size. Expected 64 bytes.",
            )
        }
        this.signer = Keypair.fromSecretKey(secretKey)
        this.publicKey = this.signer.publicKey
    }

    async signTransaction(transaction: Transaction): Promise<Transaction> {
        if ("sign" in transaction && typeof transaction.sign === "function") {
            transaction.sign([this.signer] as unknown as Signer)
            return transaction
        } else {
            throw new Error("Unknown transaction type for signing")
        }
    }

    async getLatestBlockhash(): Promise<{ blockhash: string }> {
        const { blockhash } = await this.connection.getLatestBlockhash()
        return { blockhash }
    }

    async sendTransaction(transaction: Transaction): Promise<string> {
        try {
            const { blockhash } = await this.connection.getLatestBlockhash()
            transaction.recentBlockhash = blockhash
        } catch (error) {
            console.warn(
                "getLatestBlockhash failed, falling back to getRecentBlockhash:",
                error,
            )
            const { blockhash } = await this.connection.getRecentBlockhash(
                "confirmed",
            )
            transaction.recentBlockhash = blockhash
        }

        transaction.sign(this.signer)

        const txId = await this.connection.sendRawTransaction(
            transaction.serialize(),
        )

        await this.connection.confirmTransaction(txId, "confirmed")

        return txId
    }

    getPublicKey(): PublicKey {
        return this.signer.publicKey
    }

    // Implementing missing methods and properties from SolanaWeb3
    isConnected = true // Assuming always connected

    async signAllTransactions(
        transactions: Transaction[],
    ): Promise<Transaction[]> {
        return transactions.map(tx => {
            tx.sign(this.signer)
            return tx
        })
    }

    async signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }> {
        const signature = nacl.sign.detached(message, this.signer.secretKey)
        return { signature }
    }

    async request(args: any): Promise<any> {
        throw new Error("Method not implemented.")
    }

    connect(): Promise<boolean> {
        console.log("Connected to Solana provider")
        return Promise.resolve(true)
    }

    disconnect(): Promise<boolean> {
        console.log("Disconnected from Solana provider")
        return Promise.resolve(true)
    }

    async signAndSendTransaction(
        transaction: Transaction,
    ): Promise<{ signature: string }> {
        const signedTransaction = await this.signTransaction(transaction)

        const txId = await this.connection.sendRawTransaction(
            signedTransaction.serialize(),
        )

        await this.connection.confirmTransaction(txId, "confirmed")

        return { signature: txId }
    }

    on(event: string, listener: (...args: any[]) => void): void {
        console.log(`Event listener registered for event: ${event}`)
    }

    off(event: string, listener: (...args: any[]) => void): void {
        console.log(`Event listener removed for event: ${event}`)
    }

    get signers() {
        return [this.signer]
    }
}

export default class RubicService {
    private sdk: SDK | null = null
    private customEVMProvider: CustomEVMProvider | null = null
    private customSolanaProvider: CustomSolanaProvider | null = null
    private signer: any = null
    private chain: string
    private initPromise: Promise<void> | null = null
    private receiverAddress: string | null = null

    constructor(
        privateKey: string,
        chain: string,
        receiverAddress?: string,
    ) {
        const mockPrivateKey =
            chain === BLOCKCHAIN_NAME.SOLANA
                ? mockSolanaPrivateKey
                : `0x${mockEvmPrivateKey}`

        this.chain = chain
        this.receiverAddress = receiverAddress

        if (chain === BLOCKCHAIN_NAME.SOLANA) {
            this.customSolanaProvider = new CustomSolanaProvider(
                ChainProviders.SOLANA.mainnet,
                mockPrivateKey,
            )
        } else {
            const web3Instance = new Web3(ChainProviders[`${chain}`].mainnet)
            const httpProvider =
                web3Instance.currentProvider as unknown as HttpProvider
            const formattedKey = mockPrivateKey.startsWith("0x")
                ? mockPrivateKey
                : `0x${mockPrivateKey}`
            this.signer =
                web3Instance.eth.accounts.privateKeyToAccount(formattedKey)
            web3Instance.eth.accounts.wallet.add(this.signer)
            this.customEVMProvider = new CustomEVMProvider(
                httpProvider,
                this.signer,
            )
        }

        this.initPromise = this.initializeSDK()
    }

    private async initializeSDK(): Promise<void> {
        try {
            const walletAddress =
                this.chain === BLOCKCHAIN_NAME.SOLANA
                    ? this.customSolanaProvider?.getPublicKey().toBase58()
                    : this.signer?.address

            const configuration: Configuration = {
                rpcProviders: {
                    [BLOCKCHAIN_NAME.ETHEREUM]: {
                        rpcList: [ChainProviders.ETH.mainnet],
                    },
                    [BLOCKCHAIN_NAME.POLYGON]: {
                        rpcList: [ChainProviders.POLYGON.mainnet],
                    },
                    [BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN]: {
                        rpcList: [ChainProviders.BSC.mainnet],
                    },
                    [BLOCKCHAIN_NAME.AVALANCHE]: {
                        rpcList: [ChainProviders.AVALANCHE.mainnet],
                    },
                    [BLOCKCHAIN_NAME.OPTIMISM]: {
                        rpcList: [ChainProviders.OPTIMISM.mainnet],
                    },
                    [BLOCKCHAIN_NAME.ARBITRUM]: {
                        rpcList: [ChainProviders.ARBITRUM.mainnet],
                    },
                    [BLOCKCHAIN_NAME.LINEA]: {
                        rpcList: [ChainProviders.LINEA.mainnet],
                    },
                    [BLOCKCHAIN_NAME.BASE]: {
                        rpcList: [ChainProviders.BASE.mainnet],
                    },
                    [BLOCKCHAIN_NAME.SOLANA]: {
                        rpcList: [ChainProviders.SOLANA.mainnet],
                    },
                },
                providerAddress: {
                    [CHAIN_TYPE.EVM]: {
                        crossChain: walletAddress,
                        onChain: walletAddress,
                    },
                    [CHAIN_TYPE.SOLANA]: {
                        crossChain: walletAddress,
                        onChain: walletAddress,
                    },
                },
                walletProvider: {
                    ...(this.chain !== BLOCKCHAIN_NAME.SOLANA && {
                        [CHAIN_TYPE.EVM]: {
                            core: this.customEVMProvider,
                            address: walletAddress,
                        },
                    }),
                    ...(this.chain === BLOCKCHAIN_NAME.SOLANA && {
                        [CHAIN_TYPE.SOLANA]: {
                            address: walletAddress,
                            core: this.customSolanaProvider,
                        },
                    }),
                },
            }

            this.sdk = await SDK.createSDK(configuration)
            console.log("SDK initialized successfully")
        } catch (error) {
            console.error("Error initializing SDK:", error)
            throw error
        }
    }

    public async waitForInitialization(): Promise<void> {
        return this.initPromise || Promise.resolve()
    }

    public getTokenAddress(
        chainId: number,
        symbol: "NATIVE" | "USDC" | "USDT",
    ): string {
        const blockchain = this.getBlockchainName(chainId)
        return SupportedTokens[blockchain][symbol]
    }

    async getTrade(
        payload: BridgeTradePayload,
    ): Promise<WrappedCrossChainTrade | RubicSdkError> {
        await this.waitForInitialization()

        if (!this.sdk) {
            const error = new Error("SDK not initialized") as RubicSdkError
            return error
        }

        try {
            const fromTokenAddress = this.getTokenAddress(
                payload.fromChainId,
                payload.fromToken,
            )

            const toTokenAddress = this.getTokenAddress(
                payload.toChainId,
                payload.toToken,
            )
            // Dynamically select the correct address for fromAddress
            let fromAddress = ""

            if (
                this.getBlockchainName(payload.fromChainId) ===
                BLOCKCHAIN_NAME.SOLANA
            ) {
                fromAddress = this.customSolanaProvider
                    ?.getPublicKey()
                    .toBase58()
            } else {
                fromAddress = this.signer?.address
            }

            const trades = await this.sdk.crossChainManager.calculateTrade(
                {
                    address: fromTokenAddress,
                    blockchain: this.getBlockchainName(payload.fromChainId),
                },
                payload.amount,
                {
                    address: toTokenAddress,
                    blockchain: this.getBlockchainName(payload.toChainId),
                },
                {
                    fromAddress,
                    bridgeTypes: Object.values(BRIDGE_PROTOCOLS)
                        .filter(p => p !== "all")
                        .map(p => p.toLowerCase()),
                    gasCalculation: "enabled",
                } as ExtendedCrossChainManagerCalculationOptions,
            )

            console.log(`Received ${trades.length} trade options`)

            if (trades.length === 0) {
                const error = new Error("No trades found") as RubicSdkError
                return error
            }

            const filteredTrades = trades.filter(
                trade => trade !== undefined && trade !== null && !trade.error,
            )

            const bestTrade = filteredTrades[0]
            return bestTrade
        } catch (error: any) {
            console.error("Error getting trade:", error)
            return error as RubicSdkError
        }
    }

    async executeTrade(wrappedTrade: WrappedCrossChainTrade) {
        try {
            if (!this.sdk) throw new Error("SDK not initialized")

            if (!wrappedTrade)
                throw new Error("Trade object is null or undefined")

            if (wrappedTrade.error) {
                console.error("Trade contains an error:", wrappedTrade.error)
                throw wrappedTrade.error
            }

            const trade = wrappedTrade.trade as unknown as CrossChainTrade

            if (!trade) throw new Error("Invalid trade object: trade is null")

            let signerAddress = ""

            if (this.chain === BLOCKCHAIN_NAME.SOLANA) {
                signerAddress = this.customSolanaProvider
                    ?.getPublicKey()
                    .toBase58()
                this.sdk.updateWalletAddress(CHAIN_TYPE.SOLANA, signerAddress)
            } else {
                signerAddress = this.signer?.address
                this.sdk.updateWalletAddress(CHAIN_TYPE.EVM, signerAddress)
            }

            const receiverAddress = this.receiverAddress
                ? this.receiverAddress
                : this.chain === BLOCKCHAIN_NAME.SOLANA
                ? this.customSolanaProvider?.getPublicKey().toBase58()
                : this.signer?.address

            const swapOptions: SwapTransactionOptions = {
                onConfirm: (hash: string) => {
                    console.log("Swap transaction confirmed:", hash)
                },
                onApprove: (hash: string | null) => {
                    console.log("Approval transaction:", hash)
                },
                receiverAddress,
                skipAmountCheck: false,
                useCacheData: false,
                testMode: false,
                useEip155: true,
                refundAddress: signerAddress,
            }

            const basicTransactionOptions: BasicTransactionOptions = {
                onTransactionHash: (hash: string) => {
                    console.log("Transaction hash:", hash)
                },
            }

            const needsApproval = await trade.needApprove()
            if (needsApproval) {
                console.log("Approving...")
                const approve = await trade.approve(
                    basicTransactionOptions,
                    true,
                    "infinity",
                )
                console.log("approve", approve)
            } else {
                console.log("Skipping approval, allowance is sufficient.")
            }

            const receipt = await trade.swap(swapOptions)

            return receipt
        } catch (error) {
            if (
                error instanceof RubicSdkError &&
                error.message.includes("eth_estimateGas")
            ) {
                const customError = Object.assign(
                    new RubicSdkError(error.message),
                    {
                        details: {
                            message:
                                "Insufficient gas funds for the transaction.",
                        },
                    },
                )
                throw customError
            }
            console.error("Error executing trade:", error)
            throw error
        }
    }

    getBlockchainName(chainId: number): BlockchainName {
        switch (chainId) {
            case 1:
                return BLOCKCHAIN_NAME.ETHEREUM
            case 137:
                return BLOCKCHAIN_NAME.POLYGON
            case 56:
                return BLOCKCHAIN_NAME.BINANCE_SMART_CHAIN
            case 43114:
                return BLOCKCHAIN_NAME.AVALANCHE
            case 10:
                return BLOCKCHAIN_NAME.OPTIMISM
            case 42161:
                return BLOCKCHAIN_NAME.ARBITRUM
            case 59144:
                return BLOCKCHAIN_NAME.LINEA
            case 8453:
                return BLOCKCHAIN_NAME.BASE
            case 101:
                return BLOCKCHAIN_NAME.SOLANA
            default:
                throw new Error(`Unsupported chain ID: ${chainId}`)
        }
    }
}
