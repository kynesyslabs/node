export interface GenesisProperties {
	id: number,
	name: string,
	currency: string,
}

export default interface Genesis {
    properties: GenesisProperties
	balances: [[address: string, amount: string]]
}