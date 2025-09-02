import { EVMSmartContractManagement } from "./EVMSmartContractManagement"

export class ContractManager {
    /**
     * Gets the node's wallet addresses for all initialized tanks
     * @returns An object mapping chainKey -> wallet address
     */
    static getAllTankSigners(): Record<string, string> {
        const map: Record<string, string[]> = {}
        const evm = EVMSmartContractManagement.getInstance()

        const evmSigners = evm.getTankWalletAddresses()
        const solanaSigners = {}

        return {
            ...evmSigners,
            ...solanaSigners,
        }
    }
}
