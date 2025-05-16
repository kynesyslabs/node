
// Supported chains and stablecoins
export const supportedChains = ["EVM", "SOLANA"] as const
export const supportedStablecoins = ["USDC"] as const

// Supported chains for EVM
export const supportedEVMChains = [
    "eth",
    "polygon",
    "bsc",
    "arbitrum",
    "optimism",
    "avalanche",
    "base",
] as const

// USDC contract addresses for different chains (testnet addresses)
export const usdcContracts = {
    ETHEREUM: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia USDC
    POLYGON: "0x0FA8781a83E46826621b3BC094Ea2A0212e71B23", // Mumbai USDC
    BSC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC Testnet USDC
    ARBITRUM: "0xfd064A18f3BF249cf1f87FC203E90D8f650f2d63", // Arbitrum Sepolia USDC
    OPTIMISM: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", // Optimism Sepolia USDC
    AVALANCHE: "0x5425890298aed601595a70AB815c96711a31Bc65", // Fuji USDC
    BASE: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
    SOLANA: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Solana Devnet USDC
}

// USDC ABI for balance checking
export const usdcAbi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
]
