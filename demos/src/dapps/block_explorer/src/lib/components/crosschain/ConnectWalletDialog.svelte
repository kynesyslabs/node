<script>
    import {budinofade, budinotraslato} from "$lib/transitions";
    import EVM from "$lib/demos_libs/xmlibs/chains/evm.js"
    export let connection;
    export let close;
    let error="";
    async function connectWallet(prvkey)
    {
        error = "";
        let eth_chain = await EVM.create("https://eth.llamarpc.com");
        try
        {
            await eth_chain.connectWallet(prvkey);
        }
        catch(err){
            error = err;
            return
        }
        connection.wallet = eth_chain;
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
