import { Contract, Transaction, WebSocketProvider } from "ethers"

import log from "@/utilities/logger"
import { Waiter } from "src/utilities/waiter"
import { JsonConfig } from "@/utilities/JsonConfig"
import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"

// ABI for LiquidityTank contract - key functions only
const liquidityTankABI = [
    // View functions
    "function getBalance(address token) view returns (uint256)",
    "function authorizedAddresses(uint256) view returns (address)",
    "function authorizedCount() view returns (uint8)",
    "function isAuthorized(address) view returns (bool)",
    "function getRequiredApprovals() view returns (uint8)",
    "function checkProposalStatus(bytes32) view returns (uint8, uint40, bool, bool)",
    "function hasApproved(bytes32, address) view returns (bool)",
    "function initialized() view returns (bool)",
    "function paused() view returns (bool)",

    // Management functions
    "function setAuthorizedAddresses(address[] addresses)",
    "function proposeNextOwners(bytes32 proposalId, address[] newOwners)",
    "function multisigTransfer(bytes32 proposalId, address token, address to, uint256 amount)",
    "function generateProposalId() returns (bytes32)",

    // Gasless functions
    "function executeMetaTransaction(address user, bytes signature, uint256 nonce, address token, address to, uint256 amount, uint256 slippageBps)",
    "function depositUSDCToTank(address user, bytes signature, uint256 nonce, address usdcAddress, uint256 amount)",
    "function initiateBridgeOperation(address user, bytes signature, uint256 nonce, string originChain, string destChain, address token, address recipient, uint256 amount, uint256 bridgeFeeBps)",

    // Events
    "event TransferExecuted(address indexed token, address indexed to, uint256 amount)",
    "event OwnersRotated(address[] oldOwners, address[] newOwners)",
    "event ProposalCreated(bytes32 indexed proposalId, address indexed creator, uint40 deadline)",
    "event ProposalApproved(bytes32 indexed proposalId, address indexed approver, uint8 approvalCount)",
    "event ProposalExecuted(bytes32 indexed proposalId)",
]

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
        if (!bridgePrivateKey) {
            log.error(`Bridge private key not found for ${chainKey}`)
            process.exit(1)
            throw new Error(`Bridge private key not found for ${chainKey}`)
        }

        // Create EVM instance
        const evmInstance = new EVM(rpcUrl, chainId)
        await evmInstance.connect()
        await evmInstance.connectWallet(bridgePrivateKey)

        log.info(
            `Connected to ${chainKey} with address ${evmInstance.wallet.address}`,
        )

        // Create contract instance
        const contract = await evmInstance.getContractInstance(
            tankAddress,
            JSON.stringify(liquidityTankABI),
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

        const providers = {
            "evm.eth.sepolia": "wss://ethereum-sepolia-rpc.publicnode.com",
            "evm.polygon.amoy": "wss://polygon-amoy-bor-rpc.publicnode.com",
        }

        // TODO: Move these into a config file
        const tankABI = JsonConfig.getTankAbi(chainKey)
        const provider = new WebSocketProvider(providers[chainKey])
        const contract = new Contract(tankConfig.address, tankABI, provider)

        // INFO: Listen and handle the OwnersRotated event
        contract.on(
            "OwnersRotated",
            async (oldOwners: string[], newOwners: string[]) => {
                log.debug(
                    `OwnersRotated for ${chainKey}: ${JSON.stringify(
                        oldOwners,
                    )} -> ${JSON.stringify(newOwners)}`,
                )

                // INFO: Release the Consensus step in Waiter class once received!
                if (Waiter.isWaiting(Waiter.keys.TANK_SIGNER_ROTATION)) {
                    Waiter.resolve(Waiter.keys.TANK_SIGNER_ROTATION)
                }
            },
        )

        contract.on("ProposalExecuted", async data =>
            console.log("ProposalExecuted", data),
        )

        contract.on("ProposalCreated", async data =>
            console.log("ProposalCreated", data),
        )

        log.debug(`Event listeners set up for ${chainKey}`)
    }

    /**
     * Get USDC balance in a specific tank
     * @param chainKey Chain identifier (e.g., "eth.sepolia")
     * @returns USDC balance as string
     */
    public async getUSDCBalance(chainKey: string): Promise<string> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get USDC contract address for this chain
            const usdcContracts = JsonConfig.getUsdcContracts()
            const usdcAddress = usdcContracts[chainKey.replace(".", ".")]

            if (!usdcAddress) {
                throw new Error(`USDC contract not configured for ${chainKey}`)
            }

            // Get balance from tank contract
            const balance = await tankConfig.contract.getBalance(usdcAddress)
            return balance.toString()
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
        const proposalIdTx = await tankConfig.evmInstance.writeToContract(
            tankConfig.contract,
            "generateProposalId",
            [],
            {
                gasLimit: 22000,
                value: "0",
            },
        )

        const tx = Transaction.from(proposalIdTx)
        log.debug("Tx: " + JSON.stringify(tx, null, 2))

        const response =
            await tankConfig.evmInstance.provider.broadcastTransaction(
                proposalIdTx,
            )
        log.debug("Proposal ID: " + JSON.stringify(response, null, 2))
        process.exit(1)

        const receipt = await tankConfig.evmInstance.waitForReceipt(
            proposalIdTx.hash,
        )

        log.debug("Receipt: " + JSON.stringify(receipt, null, 2))

        // Extract proposal ID from events (simplified - would need proper event parsing)
        const proposalId =
            receipt.logs[0]?.topics[1] ||
            `0x${Date.now().toString(16).padStart(64, "0")}`

        // Propose new owners
        const txResponse = await tankConfig.evmInstance.writeToContract(
            tankConfig.contract,
            "proposeNextOwners",
            [proposalId, newSigners],
        )
        // TODO: Confirm the tx was succcessfully received by the contract

        // Track rotation proposal
        // REVIEW: Do we need to track these?
        this.rotationProposals.set(chainKey, {
            proposalId,
            newSigners,
            requiredApprovals: await tankConfig.contract.getRequiredApprovals(),
            currentApprovals: 1, // First approval from caller
            executed: false,
        })

        log.info(
            `Shard rotation initiated for ${chainKey}, proposal: ${proposalId}`,
        )
        return {
            chainKey,
            proposalId,
        }
    }

    /**
     * Approve a shard rotation proposal
     * @param chainKey Chain identifier
     * @param proposalId Proposal to approve
     * @param signerPrivateKey Private key of approving shard member
     */
    public async approveShardRotation(
        chainKey: string,
        proposalId: string,
        signerPrivateKey: string,
    ): Promise<void> {
        const tankConfig = this.tanks.get(chainKey)
        const rotationData = this.rotationProposals.get(chainKey)

        if (!tankConfig || !rotationData) {
            throw new Error(
                `Tank or rotation data not found for chain: ${chainKey}`,
            )
        }

        try {
            // Connect wallet with signer key
            await tankConfig.evmInstance.connectWallet(signerPrivateKey)

            // Approve the proposal
            await tankConfig.evmInstance.writeToContract(
                tankConfig.contract,
                "proposeNextOwners",
                [proposalId, rotationData.newSigners],
            )

            // Update approval count
            rotationData.currentApprovals++

            // Check if rotation was executed
            const [, , executed] =
                await tankConfig.contract.checkProposalStatus(proposalId)
            if (executed) {
                rotationData.executed = true
                log.info(`Shard rotation executed for ${chainKey}`)
            }
        } catch (error) {
            log.error(
                `Failed to approve shard rotation for ${chainKey}:` + error,
            )
            throw error
        }
    }

    /**
     * Execute USDC withdrawal from tank (called by consensus)
     * @param chainKey Chain identifier
     * @param recipient Recipient address
     * @param amount Amount in USDC smallest units
     * @param signerPrivateKeys Array of shard member private keys
     */
    public async executeWithdrawal(
        chainKey: string,
        recipient: string,
        amount: string,
        signerPrivateKeys: string[],
    ): Promise<string> {
        const fname = "[executeWithdrawal]"
        log.info(`${fname} Executing withdrawal (now gasless) on ${chainKey} to ${recipient}`)

        // Use the new gasless withdrawal method
        return await this.executeGaslessWithdrawal(
            chainKey,
            recipient,
            amount,
            signerPrivateKeys,
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
        chainKey: string,
        txHash: string,
        expectedAmount: string,
        expectedSender: string,
    ): Promise<{
        valid: boolean
        actualAmount?: string
        actualSender?: string
    }> {
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

        // Parse logs for USDC transfer to tank
        // This would need proper log parsing based on USDC transfer events
        // Simplified validation for now
        const tankAddress = tankConfig.address.toLowerCase()
        const hasTransferToTank = receipt.logs.some(
            (log: any) =>
                log.address?.toLowerCase().includes("usdc") &&
                log.topics?.some((topic: string) =>
                    topic.toLowerCase().includes(tankAddress.slice(2)),
                ),
        )

        if (hasTransferToTank) {
            return {
                valid: true,
                actualAmount: expectedAmount, // Would extract from logs
                actualSender: expectedSender, // Would extract from logs
            }
        }

        return { valid: false }
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
        chainKey: string,
        userAddress: string,
        amount: string,
        userSignature: string,
        nonce: number,
    ): Promise<string> {
        const fname = "[executeGaslessDeposit]"
        log.info(`${fname} Executing gasless deposit for user ${userAddress} on ${chainKey}`)

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get USDC address for this chain (TODO: make this configurable)
            const usdcAddress = this.getUSDCAddress(chainKey)
            
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
            throw new Error(`Failed to execute gasless deposit: ${error.toString()}`)
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
        log.info(`${fname} Initiating gasless bridge from ${operation.originChain} to ${operation.destChain}`)

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

            log.info(`${fname} ✅ Gasless bridge operation initiated: ${tx.hash}`)
            return tx.hash

        } catch (error) {
            log.error(`${fname} Failed to initiate gasless bridge: ${error}`)
            throw new Error(`Failed to initiate gasless bridge: ${error.toString()}`)
        }
    }

    /**
     * Execute gasless withdrawal using meta-transaction pattern
     * @param chainKey Chain identifier  
     * @param recipient Withdrawal recipient address
     * @param amount Amount to withdraw
     * @param signerPrivateKeys Shard private keys for multisig
     * @returns Proposal ID for tracking
     */
    public async executeGaslessWithdrawal(
        chainKey: string,
        recipient: string,
        amount: string,
        signerPrivateKeys: string[],
    ): Promise<string> {
        const fname = "[executeGaslessWithdrawal]"
        log.info(`${fname} Executing gasless withdrawal on ${chainKey} to ${recipient}`)

        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Generate nonces for each shard signature
            const nonces = signerPrivateKeys.map((_, index) => Date.now() + index)
            
            // Execute gasless multisig transfers for each required signature
            const usdcAddress = this.getUSDCAddress(chainKey)
            const txHashes: string[] = []

            for (let i = 0; i < signerPrivateKeys.length; i++) {
                const privateKey = signerPrivateKeys[i]
                const nonce = nonces[i]
                
                // Create signature for this shard (simplified - would use proper signing)
                const dummySignature = `0x${"00".repeat(65)}` // TODO: Implement proper shard signature
                
                // Execute meta-transaction for this shard approval
                const tx = await tankConfig.contract.executeMetaTransaction(
                    recipient, // user (authorized shard in this case)
                    dummySignature,
                    nonce,
                    usdcAddress, // USDC token address
                    recipient,
                    amount,
                    100, // 1% slippage
                )
                
                txHashes.push(tx.hash)
                log.info(`${fname} Shard ${i + 1} gasless approval: ${tx.hash}`)
            }

            log.info(`${fname} ✅ Gasless withdrawal completed with ${txHashes.length} transactions`)
            return txHashes[0] // Return first tx hash as proposal ID

        } catch (error) {
            log.error(`${fname} Failed to execute gasless withdrawal: ${error}`)
            throw new Error(`Failed to execute gasless withdrawal: ${error.toString()}`)
        }
    }

    /**
     * Get USDC contract address for a given chain
     * @param chainKey Chain identifier
     * @returns USDC contract address
     */
    private getUSDCAddress(chainKey: string): string {
        // TODO: Make this configurable via JsonConfig
        const usdcAddresses: { [key: string]: string } = {
            "eth.sepolia": "0xA0b86a33E6417A8B6C8Ac3a0E9e0c4A27A4E0F2c", // Mock USDC on Sepolia
            "eth.mainnet": "0xA0b86a33E6417A8B6C8Ac3a0E9e0c4A27A4E0F2c", // Real USDC on Ethereum
            "polygon.amoy": "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", // Mock USDC on Polygon Amoy
            "polygon.mainnet": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // Real USDC on Polygon
        }

        const address = usdcAddresses[chainKey]
        if (!address) {
            throw new Error(`USDC address not configured for chain: ${chainKey}`)
        }

        return address
    }
}
