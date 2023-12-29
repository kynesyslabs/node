/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge from "node-forge"

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