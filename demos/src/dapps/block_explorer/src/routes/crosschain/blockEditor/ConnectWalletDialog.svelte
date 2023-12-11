<script>
    import {budinofade, budinotraslato} from "$lib/transitions";
    import EVM from '$lib/demos_libs/xmlibs/chains/evm';
    import XRPL from '$lib/demos_libs/xmlibs/chains/xrpl';
    import {chains} from "$lib/chainscript.js";

    let chainobjs={
        "evm":EVM,
        "xrpl":XRPL
    }

    export let connection;
    export let close;
    let error="";

    async function connectWallet(prvkey)
    {
        error = "";
        let mychainwallet;
        const thisrpc = chains.find(c=>connection.id==c.id).rpc;
        if(chains.find(c=>connection.id==c.id).is_evm)
            mychainwallet = await chainobjs["evm"].create(chains.find(c=>connection.id==c.id).rpc);
        else
            mychainwallet = await chainobjs[connection.id].create(chains.find(c=>connection.id==c.id).rpc);
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

<style>
    .operationcard-label{
        margin-bottom: 8px;
    }
</style>

<div class="modal-background" transition:budinofade>
    <div transition:budinotraslato class="modal-txblock">
        <h4 class="operationcard-label">Private key</h4>
        <input on:input={(ev)=>{
            if(ev.target.value!=""){connectWallet(ev.target.value)}
        }} placeholder="Paste here"/>
        {#if error != ""}
            <div class="alert-error">{error}</div>
        {/if}
    </div>
</div>
