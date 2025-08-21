import { EVM } from "@kynesyslabs/demosdk/xm-localsdk"
import { Contract } from "ethers"
import { evmProviders } from "sdk/localsdk/multichain/configs/evmProviders"
import { chainIds } from "sdk/localsdk/multichain/configs/chainIds"
import { JsonConfig } from "@/utilities/JsonConfig"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { ethers } from "ethers"

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

        try {
            // Create EVM instance
            const evmInstance = EVM.createInstance(chainId, rpcUrl)
            await evmInstance.connect(chainId)

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
        } catch (error) {
            log.error(`Failed to initialize tank for ${chainKey}:` + error)
            throw error
        }
    }

    /**
     * Set up event listeners for tank contract events
     * @param chainKey Chain identifier
     */
    private async setupEventListeners(chainKey: string): Promise<void> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) return

        // Listen for transfer events (deposits/withdrawals)
        // await tankConfig.evmInstance.listenForEvent(
        //     "TransferExecuted",
        //     tankConfig.address,
        //     liquidityTankABI,
        //     async data => console.log("TransferExecuted", data),
        // )
        const providers = {
            "evm.eth.sepolia": "wss://ethereum-sepolia-rpc.publicnode.com",
            "evm.polygon.amoy": "wss://polygon-amoy-bor-rpc.publicnode.com",
        }
        const tankABI = JsonConfig.getTankAbi(chainKey)
        const provider = new ethers.providers.WebSocketProvider(
            providers[chainKey],
        )
        const contract = new ethers.Contract(
            tankConfig.address,
            tankABI,
            provider,
        )
        contract.on("OwnersRotated", async data =>
            // TODO: Release the Consensus step in Waiter class once received!
            console.log("OwnersRotated", data),
        )

        // // Listen for ownership rotation events
        // await tankConfig.evmInstance.listenForEvent(
        //     "OwnersRotated",
        //     tankConfig.address,
        //     liquidityTankABI,
        //     async data => console.log("OwnersRotated", data),
        // )

        contract.on("ProposalExecuted", async data =>
            console.log("ProposalExecuted", data),
        )

        // // Listen for proposal events
        // await tankConfig.evmInstance.listenForEvent(
        //     "ProposalExecuted",
        //     tankConfig.address,
        //     liquidityTankABI,
        //     async data => console.log("ProposalExecuted", data),
        // )

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
        currentSignerPrivateKey: string,
    ): Promise<string> {
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Connect wallet with current signer key
            await tankConfig.evmInstance.connectWallet(currentSignerPrivateKey)

            // Generate unique proposal ID
            const proposalIdTx = await tankConfig.contract.generateProposalId()
            const receipt = await tankConfig.evmInstance.waitForReceipt(
                proposalIdTx.hash,
            )

            // Extract proposal ID from events (simplified - would need proper event parsing)
            const proposalId =
                receipt.logs[0]?.topics[1] ||
                `0x${Date.now().toString(16).padStart(64, "0")}`

            // Propose new owners
            await tankConfig.evmInstance.writeToContract(
                tankConfig.contract,
                "proposeNextOwners",
                [proposalId, newSigners],
            )

            // Track rotation proposal
            this.rotationProposals.set(chainKey, {
                proposalId,
                newSigners,
                requiredApprovals:
                    await tankConfig.contract.getRequiredApprovals(),
                currentApprovals: 1, // First approval from caller
                executed: false,
            })

            log.info(
                `Shard rotation initiated for ${chainKey}, proposal: ${proposalId}`,
            )
            return proposalId
        } catch (error) {
            log.error(
                `Failed to initiate shard rotation for ${chainKey}:` + error,
            )
            throw error
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
        const tankConfig = this.tanks.get(chainKey)
        if (!tankConfig) {
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get USDC contract address
            const usdcContracts = JsonConfig.getUsdcContracts()
            const usdcAddress = usdcContracts[chainKey.replace(".", ".")]

            if (!usdcAddress) {
                throw new Error(`USDC contract not configured for ${chainKey}`)
            }

            // Generate proposal ID
            const proposalId = `0x${Date.now().toString(16).padStart(64, "0")}`

            // Each signer approves the withdrawal
            for (const privateKey of signerPrivateKeys) {
                await tankConfig.evmInstance.connectWallet(privateKey)

                await tankConfig.evmInstance.writeToContract(
                    tankConfig.contract,
                    "multisigTransfer",
                    [proposalId, usdcAddress, recipient, amount],
                )
            }

            log.info(
                `USDC withdrawal executed: ${amount} to ${recipient} on ${chainKey}`,
            )
            return proposalId
        } catch (error) {
            log.error(`Failed to execute withdrawal on ${chainKey}:` + error)
            throw error
        }
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
            throw new Error(`Tank not found for chain: ${chainKey}`)
        }

        try {
            // Get transaction receipt
            const receipt = await tankConfig.evmInstance.waitForReceipt(txHash)

            if (!receipt || !receipt.logs) {
                return { valid: false }
            }

            // Parse logs for USDC transfer to tank
            // This would need proper log parsing based on USDC transfer events
            // Simplified validation for now
            const tankAddress = tankConfig.address.toLowerCase()
            // Error on 0x0000... address
            if (tankAddress === "0x0000000000000000000000000000000000000000") {
                log.error(
                    `Invalid tank address for ${chainKey}: ${tankAddress}: is the contract deployed?`,
                )
                return { valid: false }
            }
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
        } catch (error) {
            log.error(`Failed to verify deposit for ${chainKey}:` + error)
            return { valid: false }
        }
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
}
