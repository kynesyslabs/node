import Web3 from "web3"
import {
    BLOCKCHAIN_NAME,
    WrappedCrossChainTrade,
    RubicSdkError,
} from "rubic-sdk"
import {
    BridgeTradePayload,
    SupportedTokens,
    ChainProviders,
} from "@kynesyslabs/demosdk/types"
import {
    BlockchainName,
    RUBIC_API_INTEGRATOR_ADDRESS,
    RUBIC_API_REFERRER_ADDRESS,
    RUBIC_API_V2_ROUTES,
} from "./bridgeUtils"
import { Connection } from "@solana/web3.js"

export default class RubicService {
    public static getTokenAddress(
        chainId: number,
        symbol: "NATIVE" | "USDC" | "USDT",
    ): string {
        const blockchain = this.getBlockchainName(chainId)
        return SupportedTokens[blockchain][symbol]
    }

    /**
     * Gets a trade quote by calling the Rubic API v2.
     * This is the first step for a client-side signing flow.
     * @param payload - The trade details.
     * @returns The raw JSON response from the Rubic API containing quote data.
     */
    public static async getQuoteFromApi(
        payload: BridgeTradePayload,
    ): Promise<WrappedCrossChainTrade | RubicSdkError> {
        const { fromChainId, toChainId, fromToken, toToken, amount } = payload

        const fromBlockchain = RubicService.getBlockchainName(fromChainId)
        const toBlockchain = RubicService.getBlockchainName(toChainId)

        const fromTokenAddress = RubicService.getTokenAddress(
            fromChainId,
            fromToken,
        )
        const toTokenAddress = RubicService.getTokenAddress(toChainId, toToken)

        const quoteParams = {
            srcTokenBlockchain: fromBlockchain,
            srcTokenAddress: fromTokenAddress,
            srcTokenAmount: amount.toString(),
            dstTokenBlockchain: toBlockchain,
            dstTokenAddress: toTokenAddress,
            referrer: RUBIC_API_REFERRER_ADDRESS,
            integratorAddress: RUBIC_API_INTEGRATOR_ADDRESS,
        }

        try {
            const quoteResponse = await fetch(RUBIC_API_V2_ROUTES.QUOTE_BEST, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(quoteParams),
            })

            if (!quoteResponse.ok) {
                const errorText = await quoteResponse.text()
                throw new Error(
                    `Rubic API v2 (quoteBest) error: ${quoteResponse.status} ${errorText}`,
                )
            }

            return await quoteResponse.json()
        } catch (error) {
            console.error("Error fetching quote from Rubic API v2:", error)
            throw error
        }
    }

    /**
     * Gets the final swap transaction data using a quote ID from `getQuoteFromApi`.
     * This is the second step for a client-side signing flow.
     * @param payload - The trade details, user addresses, and the quote ID.
     * @returns The raw JSON response from the Rubic API containing the transaction to be signed.
     */
    public static async getSwapDataFromApi(
        payload: BridgeTradePayload & {
            fromAddress: string
            toAddress?: string
            quoteId: string
        },
    ) {
        const {
            fromChainId,
            toChainId,
            fromToken,
            toToken,
            amount,
            fromAddress,
            quoteId,
        } = payload
        const toAddress = payload.toAddress || fromAddress

        const fromBlockchain = RubicService.getBlockchainName(fromChainId)
        const toBlockchain = RubicService.getBlockchainName(toChainId)

        const fromTokenAddress = RubicService.getTokenAddress(
            fromChainId,
            fromToken,
        )
        const toTokenAddress = RubicService.getTokenAddress(toChainId, toToken)

        const quoteParams = {
            srcTokenBlockchain: fromBlockchain,
            srcTokenAddress: fromTokenAddress,
            srcTokenAmount: amount.toString(),
            dstTokenBlockchain: toBlockchain,
            dstTokenAddress: toTokenAddress,
        }

        const swapParams = {
            ...quoteParams,
            id: quoteId,
            fromAddress: fromAddress,
            integratorAddress: RUBIC_API_INTEGRATOR_ADDRESS,
            referrer: RUBIC_API_REFERRER_ADDRESS,
            receiver: toAddress,
        }

        try {
            const swapResponse = await fetch(RUBIC_API_V2_ROUTES.SWAP, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(swapParams),
            })

            if (!swapResponse.ok) {
                const errorText = await swapResponse.text()
                throw new Error(
                    `Rubic API v2 (swap) error: ${swapResponse.status} ${errorText}`,
                )
            }

            return await swapResponse.json()
        } catch (error) {
            console.error("Error fetching swap data from Rubic API v2:", error)
            throw error
        }
    }

    /**
     * Executes a raw signed transaction on the specified blockchain.
     * @param rawTx The raw signed transaction, as a hex string for EVM or base64 for Solana.
     * @param chainId The ID of the chain to execute on.
     * @returns The transaction hash.
     */
    public static async sendRawTransaction(
        rawTx: string,
        chainId: number,
    ): Promise<string> {
        const blockchainName = RubicService.getBlockchainName(chainId)

        if (blockchainName === BLOCKCHAIN_NAME.SOLANA) {
            const connection = new Connection(
                ChainProviders.SOLANA.mainnet,
                "confirmed",
            )
            // Assuming rawTx is base64 encoded for Solana
            const txId = await connection.sendRawTransaction(
                Buffer.from(rawTx, "base64"),
            )
            await connection.confirmTransaction(txId, "confirmed")
            return txId
        } else {
            const providerKey = blockchainName as keyof typeof ChainProviders

            const rpcUrl = ChainProviders[providerKey]?.mainnet
            if (!rpcUrl) {
                throw new Error(`No RPC provider found for ${blockchainName}`)
            }
            const web3 = new Web3(rpcUrl)
            const receipt = await web3.eth.sendSignedTransaction(rawTx)
            return receipt.transactionHash.toString()
        }
    }

    public static getBlockchainName(chainId: number): BlockchainName {
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
