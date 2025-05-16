// TODO This module manages solana addresses creation, linking and management
export class SolanaAddressManagement {
    private static instance: SolanaAddressManagement

    public static getInstance(): SolanaAddressManagement {
        if (!this.instance) {
            this.instance = new SolanaAddressManagement()
        }
        return this.instance
    }

    private constructor() {
    }
}