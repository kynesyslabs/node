export const chainProviders = {
    xrpl: {
        mainnet: "wss://s1.ripple.com:51234/",
        testnet: "wss://s.altnet.rippletest.net:51233/",
    },
    filecoin: {
        mainnet: "https://rpc.ankr.com/filecoin",
        calibration: "https://rpc.ankr.com/filecoin_testnet",
        testnet: "https://rpc.ankr.com/filecoin_testnet",
    },
    egld: {
        mainnet: "https://api.multiversx.com",
        testnet: "https://testnet-api.multiversx.com",
    },
    solana: {
        mainnet: "https://api.mainnet-beta.solana.com/",
        testnet: "https://api.testnet.solana.com",
        devnet: "https://api.devnet.solana.com",
    },
    ton: {
        // provided by @orbs-network/ton-access
        testnet:
            "https://ton.access.orbs.network/4412c0ff5Bd3F8B62C092Ab4D238bEE463E64412/1/testnet/toncenter-api-v2/jsonRPC",
        mainnet:
            "https://ton.access.orbs.network/4413c0ff5Bd3F8B62C092Ab4D238bEE463E64413/1/mainnet/toncenter-api-v2/jsonRPC",
    },
    evm: {
        mainnet: "https://rpc.ankr.com/eth",
        sepolia: "https://rpc.ankr.com/eth_sepolia",
        goerli: "https://ethereum-goerli.publicnode.com",
    },
    ibc: {
        mainnet: "https://stargaze-rpc.publicnode.com:443",
        testnet: "https://rpc.elgafar-1.stargaze-apis.com",
    },
    near: {
        mainnet: "https://rpc.near.org",
        testnet: "https://rpc.testnet.near.org",
    },
    btc: {
        mainnet: "https://blockstream.info/api",
        testnet: "https://blockstream.info/testnet/api",
    },
    sui: {
        mainnet: "https://sui-rpc.publicnode.com",
        testnet: "https://sui-testnet-rpc.publicnode.com",
    },
}
