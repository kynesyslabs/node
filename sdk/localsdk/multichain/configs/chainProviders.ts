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
        devnet: "https://devnet-api.multiversx.com",
    },
    solana: {
        mainnet: "https://britta-qyzo1g-fast-mainnet.helius-rpc.com",
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
    atom: {
        mainnet: "https://cosmos-rpc.publicnode.com:443",
        testnet: "https://rpc.provider-sentry-01.ics-testnet.polypore.xyz",
    },
    near: {
        mainnet: "https://rpc.fastnear.com",
        testnet: "https://test.rpc.fastnear.com",
    },
    btc: {
        mainnet: "https://blockstream.info/api",
        testnet: "https://blockstream.info/testnet/api",
    },
    aptos: {
        mainnet: "https://fullnode.mainnet.aptoslabs.com/v1",
        testnet: "https://fullnode.testnet.aptoslabs.com/v1",
        devnet: "https://fullnode.devnet.aptoslabs.com/v1",
    },
}
