import {
    Contract,
    Transaction,
    WebSocketProvider,
    solidityPackedKeccak256,
} from "ethers"

import {
    NativeBridge,
    NativeBridgeOperationCompiled,
    NativeBridgeSupportedStablecoin,
} from "@kynesyslabs/demosdk/bridge"
import log from "@/utilities/logger"
import Chain from "@/libs/blockchain/chain"
import { Waiter } from "src/utilities/waiter"
import { JsonConfig } from "@/utilities/JsonConfig"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import {
    SupportedChain,
    SupportedStablecoin,
} from "@kynesyslabs/demosdk/bridge/nativeBridgeTypes"

interface TankConfig {
    address: string
    evmInstance: EVM
    contract: Contract
    chainName: string
    subchain: string
}

interface ShardRotationData {
    proposalId: string
    newSigners: string[]
    requiredApprovals: number
    currentApprovals: number
    executed: boolean
}

/**
 * Manages EVM tank contracts across multiple chains for native bridge operations
 * Handles USDC deposits, withdrawals, shard rotation, and tank monitoring
 */
export class EVMSmartContractManagement {
    private static instance: EVMSmartContractManagement
    private tanks: Map<string, TankConfig> = new Map() // chainKey -> TankConfig
    private rotationProposals: Map<string, ShardRotationData> = new Map() // chainKey -> rotation data
    private isInitialized = false

    // REVIEW Using singleton pattern for tank management across all chains
    public static getInstance(): EVMSmartContractManagement {
        if (!this.instance) {
            this.instance = new EVMSmartContractManagement()
        }
        return this.instance
    }

    private constructor() {
        // Initialize will be called separately
    }

    /**
     * Initialize the tank management system with existing deployed contracts
     *
     * @param tankAddresses Map of chainKey -> tank contract address
     */
    public async initialize(tankAddresses: {
        [chainKey: string]: string
    }): Promise<void> {
        if (this.isInitialized) {
            log.warning("EVMSmartContractManagement already initialized")
            return
        }

        try {
            // Initialize each tank based on provided addresses
            for (const [chainKey, address] of Object.entries(tankAddresses)) {
                await this.initializeTank(chainKey, address)
            }

            this.isInitialized = true
            log.info(`Initialized ${this.tanks.size} EVM tanks`)
        } catch (error) {
            log.error(
                "Failed to initialize EVMSmartContractManagement:" + error,
            )
            throw error
        }
    }

    /**
     * Initialize a single tank for a specific chain
     * @param chainKey Format: "chain.subchain" (e.g., "eth.sepolia")
     * @param tankAddress Deployed tank contract address
     */
    private async initializeTank(
        chainKey: string,
        tankAddress: string,
    ): Promise<void> {
        log.debug(
            "initializing tank: " + chainKey + " with tank: " + tankAddress,
        )
        const [_chainType, chainName, subchain] = chainKey.split(".")
        if (!chainName || !subchain) {
            throw new Error(
                `Invalid chain key format: ${chainKey}. Expected "chain.subchain"`,
            )
        }

        // Get RPC URL and chain ID
        const rpcUrl = evmProviders[chainName]?.[subchain]
        const chainId = chainIds[chainName]?.[subchain]

        if (!rpcUrl || !chainId) {
            throw new Error(`Unsupported chain configuration: ${chainKey}`)
        }

        const bridgePrivateKey = JsonConfig.getBridgePrivateKey(chainKey)
        log.debug("bridgePrivateKey: " + bridgePrivateKey)

        if (!bridgePrivateKey) {
            log.error(`Bridge private key not found for ${chainKey}`)
            process.exit(1)
            throw new Error(`Bridge private key not found for ${chainKey}`)
        }

        // Create EVM instance
        const evmInstance = new EVM(rpcUrl, chainId)
        await evmInstance.connect()
        await evmInstance.connectWallet(bridgePrivateKey)

        log.debug("public key: " + evmInstance.getAddress())

        log.info(
            `Connected to ${chainKey} with address ${evmInstance.wallet.address}`,
        )

        // Create contract instance
        const tankABI = JsonConfig.getTankAbi(chainKey)
        const contract = await evmInstance.getContractInstance(
            tankAddress,
            JSON.stringify(tankABI),
        )

        // Verify contract is initialized
        const isContractInitialized = await contract.initialized()
        if (!isContractInitialized) {
            log.warning(
                `Tank contract at ${tankAddress} on ${chainKey} is not initialized`,
            )
        }

        // Store tank configuration
        this.tanks.set(chainKey, {
            address: tankAddress,
            evmInstance,
            contract,
            chainName,
            subchain,
        })

        // Set up event listeners for this tank
        await this.setupEventListeners(chainKey)

        log.info(`Tank initialized: ${chainKey} at ${tankAddress}`)
    }

    /**
     * Set up event listeners for tank contract events
     * @param chainKey Chain identifier
     */
    private async setupEventListeners(chainKey: string): Promise<void> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) return

        const tankABI = JsonConfig.getTankAbi(chainKey)
        const providerUrl = JsonConfig.getWebSocketProvider(chainKey)

        const provider = new WebSocketProvider(providerUrl)
        const contract = new Contract(tankConfig.address, tankABI, provider)

        // INFO: Listen and handle the OwnersRotated event
        contract.on(
            "OwnersRotated",
            async (oldOwners: string[], newOwners: string[]) => {
                const waiterKey = Waiter.keys.TANK_SIGNER_ROTATION + chainKey

                log.debug(
                    `OwnersRotated for ${chainKey}: ${JSON.stringify(
                        oldOwners,
                    )} -> ${JSON.stringify(newOwners)}`,
                )

                // INFO: Release the Consensus step in Waiter class once received!
                if (Waiter.isWaiting(waiterKey)) {
                    Waiter.resolve(waiterKey)
                }
            },
        )

        // contract.on(
        //     "ProposalCreated",
        //     async ({ proposalId, creator, deadline }) => {
        //         const waiterKey = Waiter.keys.PROPOSAL_CREATED + chainKey

        //         log.debug(
        //             "ProposalExecuted" +
        //                 chainKey +
        //                 " " +
        //                 JSON.stringify(
        //                     { proposalId, creator, deadline },
        //                     null,
        //                     2,
        //                 ),
        //         )
        //         process.exit(1)

        //         if (Waiter.isWaiting(waiterKey)) {
        //             Waiter.resolve(waiterKey, {
        //                 proposalId,
        //                 creator,
        //                 deadline,
        //             })
        //         }
        //     },
        // )

        // contract.on("ProposalCreated", async data =>
        //     console.log("ProposalCreated", data),
        // )

        log.debug(`Event listeners set up for ${chainKey}`)
    }

    /**
     * Get USDC balance in a specific tank
     * @param chainKey Chain identifier (e.g., "eth.sepolia")
     * @returns USDC balance as string
     */
    public async getUSDCBalance(chainKey: string): Promise<bigint> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get USDC contract address for this chain
            const usdcContracts = JsonConfig.getStableCoinContracts("usdc")
            const usdcAddress = usdcContracts[chainKey]

            if (!usdcAddress) {
                throw new Error(`USDC contract not configured for ${chainKey}`)
            }

            // Get balance from tank contract
            return await tankConfig.contract.getBalance(usdcAddress)
        } catch (error) {
            log.error(`Failed to get USDC balance for ${chainKey}:` + error)
            throw error
        }
    }

    /**
     * Get current authorized addresses (shard members) for a tank
     * @param chainKey Chain identifier
     * @returns Array of authorized addresses
     */
    public async getAuthorizedAddresses(chainKey: string): Promise<string[]> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            const count = await tankConfig.contract.authorizedCount()
            const addresses: string[] = []

            for (let i = 0; i < count; i++) {
                const address = await tankConfig.contract.authorizedAddresses(i)
                addresses.push(address)
            }

            return addresses
        } catch (error) {
            log.error(
                `Failed to get authorized addresses for ${chainKey}:` + error,
            )
            throw error
        }
    }

    /**
     * Initiate shard rotation for a specific tank
     * @param chainKey Chain identifier
     * @param newSigners Array of new shard member addresses
     * @param currentSignerPrivateKey Private key of current shard member
     * @returns Proposal ID for tracking
     */
    public async initiateShardRotation(
        chainKey: string,
        newSigners: string[],
    ): Promise<{
        chainKey: string
        proposalId: string
    }> {
        const waiterKey = Waiter.keys.TANK_SIGNER_ROTATION + chainKey
        const nonce = BigInt(await Chain.getLastBlockNumber())
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            log.error(`Tank not found for chain: ${chainKey}`)
            process.exit(1)
        }

        // Generate unique proposal ID
        log.debug("Generating proposal ID")
        // const proposalIdTx = await tankConfig.contract.generateProposalId()
        const balance = await tankConfig.evmInstance.getBalance(
            tankConfig.evmInstance.wallet.address,
        )
        log.debug("Balance: " + balance)
        const gasData = await tankConfig.evmInstance.provider.getFeeData()
        log.debug("Gas data: " + JSON.stringify(gasData, null, 2))
        log.debug(
            "Contract ABI: " + JSON.stringify(tankConfig.contract.abi, null, 2),
        )
        const rotateSignersTx = await tankConfig.evmInstance.writeToContract(
            tankConfig.contract,
            "proposeNextOwners",
            [nonce, newSigners],
        )
        // log contract abi being used by contract instance
        // const tx = Transaction.from(proposalIdTx)
        // log.debug("Tx: " + JSON.stringify(tx, null, 2))

        const response =
            await tankConfig.evmInstance.provider.broadcastTransaction(
                rotateSignersTx,
            )
        log.debug("Broadcast response: " + JSON.stringify(response, null, 2))
        log.debug("Broadcast response hash: " + response.hash)
        // process.exit(1)

        // INFO: wait for tx to get 1 confirmation
        // const receipt =
        //     await tankConfig.evmInstance.provider.waitForTransaction(
        //         response.hash,
        //         1,
        //     )

        // log.debug("Receipt: " + JSON.stringify(receipt, null, 2))
        return await Waiter.wait(waiterKey, 30000)

        // Propose new owners
        // const txResponse = await tankConfig.evmInstance.writeToContract(
        //     tankConfig.contract,
        //     "proposeNextOwners",
        //     [nonce, newSigners],
        // )
        // TODO: Confirm the tx was succcessfully received by the contract

        // Track rotation proposal
        // REVIEW: Do we need to track these?
        // this.rotationProposals.set(chainKey, {
        //     nonce,
        //     newSigners,
        //     requiredApprovals: await tankConfig.contract.getRequiredApprovals(),
        //     currentApprovals: 1, // First approval from caller
        //     executed: false,
        // })

        // log.info(
        //     `Shard rotation initiated for ${chainKey}, proposal: ${proposalId}`,
        // )
        // return {
        //     chainKey,
        //     proposalId,
        // }
    }

    // /**
    //  * Approve a shard rotation proposal
    //  * @param chainKey Chain identifier
    //  * @param proposalId Proposal to approve
    //  * @param signerPrivateKey Private key of approving shard member
    //  */
    // public async approveShardRotation(
    //     chainKey: string,
    //     proposalId: string,
    //     signerPrivateKey: string,
    // ): Promise<void> {
    //     const tankConfig = this.tanks.get(chainKey)
    //     const rotationData = this.rotationProposals.get(chainKey)

    //     if (!tankConfig || !rotationData) {
    //         throw new Error(
    //             `Tank or rotation data not found for chain: ${chainKey}`,
    //         )
    //     }

    //     try {
    //         // Connect wallet with signer key
    //         await tankConfig.evmInstance.connectWallet(signerPrivateKey)

    //         // Approve the proposal
    //         await tankConfig.evmInstance.writeToContract(
    //             tankConfig.contract,
    //             "proposeNextOwners",
    //             [proposalId, rotationData.newSigners],
    //         )

    //         // Update approval count
    //         rotationData.currentApprovals++

    //         // Check if rotation was executed
    //         const [, , executed] =
    //             await tankConfig.contract.checkProposalStatus(proposalId)
    //         if (executed) {
    //             rotationData.executed = true
    //             log.info(`Shard rotation executed for ${chainKey}`)
    //         }
    //     } catch (error) {
    //         log.error(
    //             `Failed to approve shard rotation for ${chainKey}:` + error,
    //         )
    //         throw error
    //     }
    // }

    /**
     * Execute USDC withdrawal from tank (called by consensus)
     * @param bridgeId Bridge ID
     * @param chainKey Chain identifier
     * @param recipient Recipient address
     * @param tokenName Token name
     * @param amount Amount in USDC smallest units
     *
     * @returns Withdrawal transaction hash
     */
    public async executeWithdrawal(
        bridgeId: string,
        chainKey: string,
        recipient: string,
        tokenName: NativeBridgeSupportedStablecoin,
        amount: bigint,
    ): Promise<string> {
        const fname = "[executeWithdrawal]"
        log.info(
            `${fname} Executing withdrawal (now gasless) on ${chainKey} to ${recipient}`,
        )

        // Use the new gasless withdrawal method
        return await this.executeGaslessWithdrawal(
            bridgeId,
            chainKey,
            recipient,
            tokenName,
            amount,
        )
    }

    /**
     * Check if a deposit transaction exists and is valid
     * @param chainKey Chain identifier
     * @param txHash Transaction hash to verify
     * @param expectedAmount Expected deposit amount
     * @param expectedSender Expected sender address
     * @returns Validation result
     */
    public async verifyDeposit(
        txHash: string,
        compiled: NativeBridgeOperationCompiled,
    ): Promise<{
        valid: boolean
    }> {
        const chainKey = compiled.content.operation.from.chain

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            log.error(`Tank not found for chain: ${chainKey}`)
            process.exit(1)
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        // Get transaction receipt
        const receipt = await tankConfig.evmInstance.waitForReceipt(txHash)

        if (!receipt || !receipt.logs) {
            return { valid: false }
        }

        const bridge = new NativeBridge(null, tankConfig.evmInstance as any)

        // NOTE: This should never throw an error
        // because this same method is called during the broadcast step
        try {
            return bridge.verifyDepositTx(
                receipt as any,
                { response: compiled } as any,
            )
        } catch (error) {
            // INFO: In case of error, die for debugging!
            console.error(error)
            process.exit(1)
        }

        // Parse logs for USDC transfer to tank
        // This would need proper log parsing based on USDC transfer events
        // Simplified validation for now
        // const tankAddress = tankConfig.address.toLowerCase()
        // const hasTransferToTank = receipt.logs.some(
        //     (log: any) =>
        //         log.address?.toLowerCase().includes("usdc") &&
        //         log.topics?.some((topic: string) =>
        //             topic.toLowerCase().includes(tankAddress.slice(2)),
        //         ),
        // )

        // if (hasTransferToTank) {
        //     return {
        //         valid: true,
        //         actualAmount: expectedAmount, // Would extract from logs
        //         actualSender: expectedSender, // Would extract from logs
        //     }
        // }

        // return { valid: false }
    }

    /**
     * Get tank configuration for a chain
     * @param chainKey Chain identifier
     * @returns Tank configuration or null
     */
    public getTankConfig(chainKey: string): TankConfig | null {
        return this.tanks.get(chainKey) || null
    }

    /**
     * Returns a map of chainKey -> wallet address for all initialized tanks
     */
    public getTankWalletAddresses(): Record<string, string> {
        const map: Record<string, string> = {}

        for (const [chainKey, tankConfig] of this.tanks) {
            map[chainKey] = tankConfig.evmInstance.wallet.address
        }

        return map
    }

    /**
     * Get all supported chain keys
     * @returns Array of supported chain keys
     */
    public getSupportedChains(): string[] {
        return Array.from(this.tanks.keys())
    }

    /**
     * Get rotation proposal status for a chain
     * @param chainKey Chain identifier
     * @returns Rotation proposal data or null
     */
    public getRotationProposal(chainKey: string): ShardRotationData | null {
        return this.rotationProposals.get(chainKey) || null
    }

    /**
     * Check if the management system is properly initialized
     * @returns Initialization status
     */
    public isReady(): boolean {
        return this.isInitialized && this.tanks.size > 0
    }

    /**
     * Get status of all tanks
     * @returns Status information for all tanks
     */
    public async getStatusReport(): Promise<{
        [chainKey: string]: {
            address: string
            initialized: boolean
            paused: boolean
            usdcBalance: string
            authorizedCount: number
            rotationInProgress: boolean
        }
    }> {
        const report: any = {}

        for (const [chainKey, config] of this.tanks) {
            try {
                report[chainKey] = {
                    address: config.address,
                    initialized: await config.contract.initialized(),
                    paused: await config.contract.paused(),
                    usdcBalance: await this.getUSDCBalance(chainKey),
                    authorizedCount: await config.contract.authorizedCount(),
                    rotationInProgress: this.rotationProposals.has(chainKey),
                }
            } catch (error) {
                report[chainKey] = {
                    address: config.address,
                    error: error,
                }
            }
        }

        return report
    }

    // SECTION: Gasless Methods for Phase 3

    /**
     * Execute gasless USDC deposit to tank
     * @param chainKey Chain identifier (e.g., "eth.sepolia")
     * @param userAddress User's wallet address
     * @param amount Amount to deposit in USDC (in smallest units)
     * @param userSignature User's signature authorizing the deposit
     * @param nonce Nonce for replay protection
     * @returns Transaction hash
     */
    public async executeGaslessDeposit(
        chainKey: SupportedStablecoin,
        userAddress: string,
        amount: string,
        userSignature: string,
        nonce: number,
    ): Promise<string> {
        const fname = "[executeGaslessDeposit]"
        log.info(
            `${fname} Executing gasless deposit for user ${userAddress} on ${chainKey}`,
        )

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get USDC address for this chain (TODO: make this configurable)
            const usdcAddress = JsonConfig.getStableCoinContracts(chainKey)

            // Execute gasless deposit via contract
            const tx = await tankConfig.contract.depositUSDCToTank(
                userAddress,
                userSignature,
                nonce,
                usdcAddress,
                amount,
            )

            log.info(`${fname} ✅ Gasless deposit executed: ${tx.hash}`)
            return tx.hash
        } catch (error) {
            log.error(`${fname} Failed to execute gasless deposit: ${error}`)
            throw new Error(
                `Failed to execute gasless deposit: ${error.toString()}`,
            )
        }
    }

    /**
     * Initiate gasless bridge operation
     * @param chainKey Chain identifier for origin chain
     * @param operation Bridge operation parameters
     * @param userSignature User's signature authorizing the bridge
     * @returns Transaction hash
     */
    public async initiateGaslessBridgeOperation(
        chainKey: string,
        operation: {
            user: string
            nonce: number
            originChain: string
            destChain: string
            token: string
            recipient: string
            amount: string
            bridgeFeeBps: number
        },
        userSignature: string,
    ): Promise<string> {
        const fname = "[initiateGaslessBridgeOperation]"
        log.info(
            `${fname} Initiating gasless bridge from ${operation.originChain} to ${operation.destChain}`,
        )

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Execute gasless bridge initiation via contract
            const tx = await tankConfig.contract.initiateBridgeOperation(
                operation.user,
                userSignature,
                operation.nonce,
                operation.originChain,
                operation.destChain,
                operation.token,
                operation.recipient,
                operation.amount,
                operation.bridgeFeeBps,
            )

            log.info(
                `${fname} ✅ Gasless bridge operation initiated: ${tx.hash}`,
            )
            return tx.hash
        } catch (error) {
            log.error(`${fname} Failed to initiate gasless bridge: ${error}`)
            throw new Error(
                `Failed to initiate gasless bridge: ${error.toString()}`,
            )
        }
    }

    /**
     * Execute gasless withdrawal using meta-transaction pattern
     * @param bridgeId Bridge ID
     * @param chainKey Chain identifier
     * @param recipient Withdrawal recipient address
     * @param amount Amount to withdraw
     *
     * @returns Withdrawal transaction hash
     */
    public async executeGaslessWithdrawal(
        bridgeId: string,
        chainKey: string,
        recipient: string,
        tokenName: NativeBridgeSupportedStablecoin,
        amount: bigint,
    ): Promise<string> {
        const fname = "[executeGaslessWithdrawal]"
        log.debug(
            `${fname} Executing gasless withdrawal on ${chainKey} to ${recipient}`,
        )

        const tankConfig = this.tanks.get(chainKey)
        const { contract, evmInstance } = tankConfig
        if (!tankConfig) {
            log.error(`Tank not found for chain: ${chainKey}`)
            process.exit(1)
        }

        log.debug("bridgeId: " + bridgeId)
        log.debug("tokenName: " + tokenName)
        log.debug("amount: " + amount.toString())
        log.debug("recipient: " + recipient)
        log.debug("chainKey: " + chainKey)
        log.debug("Multisig signer address: " + evmInstance.getAddress())

        try {
            // REVIEW: Updated to use multisig pattern instead of non-existent executeMetaTransaction
            // Generate unique proposal ID for this withdrawal
            // const proposalId = `0x${Date.now().toString(16).padStart(64, "0")}`

            // Execute multisig transfer using existing multisig functionality
            const usdcAddress = JsonConfig.getContractAddress(
                tokenName,
                chainKey,
            )

            const tx = await evmInstance.writeToContract(
                contract,
                "multisigTransfer",
                [bridgeId, usdcAddress, recipient, amount, 0],
                {
                    gasLimit: 400_000,
                    gasPrice: 1.8,
                    maxFeePerGas: 1.8,
                    maxPriorityFeePerGas: 1.8,
                },
            )

            const txhash = Transaction.from(tx).hash
            log.debug("Multisig txhash: " + txhash)

            const response = await evmInstance.sendSignedTransaction(tx)
            log.debug("Multisig response: " + JSON.stringify(response, null, 2))

            if (response.result === "error") {
                log.error(`${fname} Failed to execute gasless withdrawal`)
                log.error("RESPONSE: " + JSON.stringify(response, null, 2))
                process.exit(1)
            }

            log.debug("RESPONSE: " + JSON.stringify(response, null, 2))
            // const receipt = await evmInstance.provider.waitForTransaction(
            //     response.hash,
            // )

            // if (!receipt || !receipt.logs || receipt.status !== 1) {
            //     log.error("Failed to execute gasless withdrawal")
            //     log.error("RECEIPT: " + JSON.stringify(receipt, null, 2))
            //     process.exit(1)
            // }

            return response.hash
        } catch (error) {
            console.error(error)
            process.exit(1)

            log.error(`${fname} Failed to execute gasless withdrawal: ${error}`)
            throw new Error(
                `Failed to execute gasless withdrawal: ${error.toString()}`,
            )
        }
    }

    /**
     * Execute atomic gasless deposit and bridge operation using the new combined method
     * @param chainKey Chain identifier (e.g., "eth.sepolia")
     * @param userAddress User's wallet address
     * @param tokenName Human-readable token name (e.g., "usdc", "eth")
     * @param amount Amount to deposit and bridge (must be equal)
     * @param destChain Destination chain name (e.g., "polygon")
     * @param recipient Recipient address on destination chain
     * @param bridgeFeeBps Bridge fee in basis points (e.g., 25 for 0.25%)
     * @param userSignature User's signature authorizing the combined operation
     * @param nonce Nonce for replay protection
     * @returns Transaction hash
     */
    public async executeAtomicDepositAndBridge(
        chainKey: string,
        userAddress: string,
        tokenName: string,
        amount: string,
        destChain: string,
        recipient: string,
        bridgeFeeBps: number,
        userSignature: string,
        nonce: number,
    ): Promise<string> {
        const fname = "[executeAtomicDepositAndBridge]"
        log.info(
            `${fname} Executing atomic deposit and bridge for user ${userAddress} on ${chainKey}`,
        )

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // REVIEW: Using new depositAndBridge method for atomic operation
            const tx = await tankConfig.contract.depositAndBridge(
                userAddress,
                userSignature,
                nonce,
                tokenName, // Human-readable token name
                amount, // Amount to deposit and bridge (equal values)
                destChain, // Destination chain
                recipient, // Recipient on destination chain
                bridgeFeeBps, // Bridge fee in basis points
                { value: tokenName === "eth" ? amount : 0 }, // Send ETH if bridging ETH
            )

            log.info(
                `${fname} ✅ Atomic deposit and bridge executed: ${tx.hash}`,
            )
            return tx.hash
        } catch (error) {
            log.error(
                `${fname} Failed to execute atomic deposit and bridge: ${error}`,
            )
            throw new Error(
                `Failed to execute atomic deposit and bridge: ${error.toString()}`,
            )
        }
    }

    /**
     * Configure token name mapping (deployer/owner only)
     * @param chainKey Chain identifier
     * @param tokenName Human-readable token name (e.g., "usdc", "eth")
     * @param tokenAddress Token contract address (use ethers.ZeroAddress for ETH)
     * @returns Transaction hash
     */
    public async setTokenNameMapping(
        chainKey: string,
        tokenName: string,
        tokenAddress: string,
    ): Promise<string> {
        const fname = "[setTokenNameMapping]"
        log.info(
            `${fname} Setting token mapping: ${tokenName} -> ${tokenAddress} on ${chainKey}`,
        )

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // REVIEW: Configure token name mapping for user convenience
            const tx = await tankConfig.contract.setTokenNameMapping(
                tokenName,
                tokenAddress,
            )

            log.info(`${fname} ✅ Token mapping configured: ${tx.hash}`)
            return tx.hash
        } catch (error) {
            log.error(`${fname} Failed to set token mapping: ${error}`)
            throw new Error(`Failed to set token mapping: ${error.toString()}`)
        }
    }

    /**
     * Get token address by human-readable name
     * @param chainKey Chain identifier
     * @param tokenName Token name (e.g., "usdc", "eth")
     * @returns Token contract address
     */
    public async getTokenByName(
        chainKey: string,
        tokenName: string,
    ): Promise<string> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            const tokenAddress = await tankConfig.contract.getTokenByName(
                tokenName,
            )
            return tokenAddress
        } catch (error) {
            log.error(
                `Failed to get token address for ${tokenName} on ${chainKey}: ${error}`,
            )
            throw error
        }
    }

    public async validateBridgeId(
        bridgeId: string,
        chain: SupportedChain,
    ): Promise<{
        valid: boolean
        message: string
    }> {
        const tankConfig = this.tanks.get(chain)

        if (!tankConfig) {
            return {
                valid: false,
                message: `Tank not found for chain: ${chain}`,
            }
        }

        const contract = tankConfig.contract

        // [approvalCount, deadline, executed, expired]
        type ProposalStatus = [number, number, boolean, boolean]

        // Derive bytes32 proposalId from bridgeId and contract address to match _generateProposalId
        const contractAddress = await contract.getAddress()
        const proposalId = solidityPackedKeccak256(
            ["string", "string", "address"],
            ["MULTISIG_PROPOSAL", "bridge_3c5aeee771e6d664", contractAddress],
        )

        const [approvalCount, deadline, executed, expired] =
            (await contract.checkProposalStatus(proposalId)) as ProposalStatus
        log.debug(
            "status: " +
                JSON.stringify([approvalCount, executed, expired, deadline]),
        )

        if (executed) {
            return {
                valid: false,
                message: `Bridge operation: ${bridgeId} has already been executed. Status: ${
                    executed ? "executed" : expired ? "expired" : "seen"
                }`,
            }
        }

        return {
            valid: true,
            message: `Bridge ID not found: ${bridgeId}`,
        }
    }
}
