// TODO This module manages smart contracts (tanks) on EVM chains for the native bridge
export class EVMSmartContractManagement {
    private static instance: EVMSmartContractManagement

    public static getInstance(): EVMSmartContractManagement {
        if (!this.instance) {
            this.instance = new EVMSmartContractManagement()
        }
        return this.instance
    }

    private constructor() {
    }
}
