<script>
    import {budinofade, budinotraslato} from "$lib/transitions";
    import EVM from '$lib/demos_libs/xmlibs/chains/evm';
    import XRPL from '$lib/demos_libs/xmlibs/chains/xrpl';

    let chainobjs={
        "evm":EVM,
        "xrpl":XRPL
    }

    let rpcaddresses = {
        "evm":"https://eth.llamarpc.com",
        "xrpl":"wss://xrplcluster.com"
    }
    
    export let connection;
    export let close;
    let error="";
    async function connectWallet(prvkey)
    {
        error = "";
        let mychainwallet = await chainobjs[connection.id].create(rpcaddresses[connection.id]);
        try
        {
            await mychainwallet.connectWallet(prvkey);
        }
        catch(err){
            error = err;
            return
        }
        connection.wallet = mychainwallet;
        close();
    }
</script>

<div class="modal-background" transition:budinofade>
    <div transition:budinotraslato class="modal-txblock">
        <h3 class="operationcard-label">Private key</h3>
        <input on:input={(ev)=>{
            if(ev.target.value!=""){connectWallet(ev.target.value)}
        }} placeholder="Paste here your private key"/>
        {#if error != ""}
            <div class="alert-error">{error}</div>
        {/if}
    </div>
</div>
