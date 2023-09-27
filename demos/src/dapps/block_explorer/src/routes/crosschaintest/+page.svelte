<script>
    import EVM from "$lib/demos_libs/xmlibs/chains/evm.js"
    import demos from "$lib/demos.js"
    // This is a XM transaction ready to be sent
    let xmtx = {
                chain: "ethereum",
                subchain: "mainnet",
                is_evm: true,
                rpc: "https://eth.llamarpc.com",
                task: {
                    type: "pay",
                    params: {
                        to: "0x802fCfc793a60F45B0EEa6301a4E2c282Cb26845",
                        amount: 1000000000
                    },
                    signedPayloads: [],
                },
    }

    async function prepare()
    {
        let eth_chain = await EVM.create("https://eth.llamarpc.com");
        eth_chain.connectWallet("54c42954e6d2e4b5d3bb487c4f34aeffa26b9eccce5dba87dcf50a67c69f512c");
        // Let's obtain a signed payload
        let signedPayload = await eth_chain.preparePay("0x802fCfc793a60F45B0EEa6301a4E2c282Cb26845", "1.0")
        
        xmtx.task.signedPayloads.push(signedPayload);

        // We have a valid task to send!
        let result = await demos.crosschain.execute(xmtx)

        console.log(result);
    }

    prepare();
    console.log(xmtx);
</script>