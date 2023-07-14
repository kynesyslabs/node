import forge from 'node-forge';

interface TokenTransfer {
	address: string
	amount: number
}

interface NFTTransfer {
	address: string
	tokenId: string
	amount: number
}

export default interface StateChange {
	// Structure for state change
	sender: forge.pki.ed25519.BinaryBuffer
	receiver: forge.pki.ed25519.BinaryBuffer
	nativeAmount: number
	tx_hash: string
	token: TokenTransfer
	nft: NFTTransfer
}