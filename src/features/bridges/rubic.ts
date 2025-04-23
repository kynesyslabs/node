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

export default class RubicService {
    private sdk: SDK | null = null
    private customEVMProvider: CustomEVMProvider
    private signer: any
    private initPromise: Promise<void> | null = null

    constructor(privateKey: string, chain: string) {
        const web3Instance = new Web3(ChainProviders[`${chain}`].mainnet)

        const httpProvider =
            web3Instance.currentProvider as unknown as HttpProvider

        const formattedKey = privateKey.startsWith("0x")
            ? privateKey
            : `0x${privateKey}`

        this.signer =
            web3Instance.eth.accounts.privateKeyToAccount(formattedKey)
        web3Instance.eth.accounts.wallet.add(this.signer)
        this.customEVMProvider = new CustomEVMProvider(
            httpProvider,
            this.signer,
        )

        this.initPromise = this.initializeSDK()
    }

    private async initializeSDK(): Promise<void> {
        try {
            const walletAddress = this.signer.address

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
                },
                walletProvider: {
                    [CHAIN_TYPE.EVM]: {
                        core: this.customEVMProvider,
                        address: walletAddress,
                    },
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
                    fromAddress: this.signer.address,
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
        if (!this.sdk) throw new Error("SDK not initialized")

        if (!wrappedTrade) throw new Error("Trade object is null or undefined")

        if (wrappedTrade.error) {
            console.error("Trade contains an error:", wrappedTrade.error)
            throw wrappedTrade.error
        }

        const trade = wrappedTrade.trade as unknown as CrossChainTrade

        if (!trade) throw new Error("Invalid trade object: trade is null")

        try {
            const signerAddress = this.signer.address
            this.sdk.updateWalletAddress(CHAIN_TYPE.EVM, signerAddress)

            const swapOptions: SwapTransactionOptions = {
                onConfirm: (hash: string) => {
                    console.log("Swap transaction confirmed:", hash)
                },
                onApprove: (hash: string | null) => {
                    console.log("Approval transaction:", hash)
                },
                receiverAddress: signerAddress,
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
