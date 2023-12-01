<script>
    import {chains} from "$lib/chainscript";
    import {trim_address} from "$lib/env";
    import EVM from '$lib/demos_libs/xmlibs/chains/evm';
    import XRPL from '$lib/demos_libs/xmlibs/chains/xrpl';
    import XMTransactions from "$lib/demos_libs/XMTransactions.js";
	import { useStore } from "@xyflow/svelte";
    import cloneDeep from 'lodash/cloneDeep';

    const {nodes, edges} = useStore();

    let chainobjs={
        "evm":EVM,
        "xrpl":XRPL
    }

    export let required_connections
    let editing = false;
    //private key input errors
    let wallet_errors = {};
    $:console.log(wallet_errors);
    //signing, validating, executing errors
    let execution_errors = [];
    async function connectWallet(connection, prvkey)
    {
        wallet_errors[connection.id] = undefined;
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
            wallet_errors[connection.id].push(err);
            return
        }
        connection.wallet = mychainwallet;
        editing=false;
    }

    async function signAll(myedge, resolvePromise, rejectPromise)
    {
        if(!myedge)
        {
            resolvePromise();
            return
        }
        let nodesClone = cloneDeep($nodes);
		const targetnode = nodesClone.find(node=>node.id==myedge.target);
        if(!targetnode)
        {
            resolvePromise();
            return
        }
        try{
            let wallet = $required_connections.find(rq=>rq.id==targetnode.data.operation.chain).wallet;
            let signedPayload = await wallet.preparePay(targetnode.data.operation.task.params.to, targetnode.data.operation.task.params.amount);
            targetnode.data.operation.task.signedPayloads = [signedPayload];
            nodes.set(nodesClone);
            signAll($edges.find(edge=>edge.source==myedge.target), resolvePromise, rejectPromise)
        }
        catch(err){
            rejectPromise({chain: targetnode.data.operation.chain, error: err});
        }
    }
    
    function flowToChainscript(nodes, edges, myedge, resolvePromise)
    {
        if(!myedge)
        {
            resolvePromise();
            return
        }
		const targetnode = nodes.find(node=>node.id==myedge.target);
        if(!targetnode)
        {
            resolvePromise();
            return
        }
        XMTransactions.operation.create(targetnode.data.id, targetnode.data.operation.chain, targetnode.data.operation.subchain, targetnode.data.operation.is_evm, targetnode.data.operation.rpc, targetnode.data.operation.task, targetnode.data.operation.conditional)
        flowToChainscript(nodes, edges, edges.find(edge=>edge.source==myedge.target), resolvePromise)
    }

    function execute()
    {
        wallet_errors = {};
        const signPromise = new Promise((resolve, reject)=>{
            signAll($edges.find(edge=>edge.source=="start"), resolve, reject)
        })
        signPromise.then(()=>{
            console.log("signed")
        }).catch((err)=>{
            wallet_errors[err.chain] = err;
        })
        const chainscriptPromise = new Promise((resolve, reject)=>{
            console.log("nuova promise")
            flowToChainscript($nodes, $edges, $edges.find(edge=>edge.source=="start"), resolve)
        })
        chainscriptPromise.then(()=>{
            console.log("chainscript", XMTransactions.operation.get())
        })
    }
</script>

<div style="margin-bottom: 32px;">
    <h4>Required Wallets</h4>
    <div class="label">You need to connect the following wallets to execute the transaction</div>
</div>
{#each $required_connections as required_wallet}
    <div class="wallet-connection card">
        <!-- CHAIN NAME AND ICON-->
        <div class="wallet-info">
            {#if chains.find(ch=>ch.id==required_wallet.id).icon}
            <img style="margin-bottom: 20px;" alt="chain icon" src={chains.find(ch=>ch.id==required_wallet.id).icon} width="24" height="24"/>
            {/if}
            <h4 class="network-name">{chains.find(ch=>ch.id==required_wallet.id).label}</h4>
        </div>
        <!-- CONNECTED? WALLET INFO -->
        {#if required_wallet.wallet}
            <div class="wallet-info">
                <p class="wallet-address">{trim_address(required_wallet.wallet.getAddress(), 20)}</p>
                <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
            </div>
        <!-- KEY INPUT AND CONNECT BUTTON -->
        {:else}
            {#if !editing}
            <button on:click={()=>{editing=required_wallet.id}} class="secondary" style="width: 100%; justify-content:center;">Connect Wallet</button>
            {:else if editing == required_wallet.id}
                <label class="operationcard-label label">Private key</label>
                <input class="prv-input" on:input={(ev)=>{
                    if(ev.target.value!=""){connectWallet(required_wallet, ev.target.value)}
                }} placeholder="Paste here"/>
                {#if wallet_errors[required_wallet.id]}
                    {#each wallet_errors[required_wallet.id] as error}
                        <div class="alert-error">{error}</div>
                    {/each}
                {/if}
            {/if}
        {/if}
        <!-- ERRORS -->
        {#if wallet_errors[required_wallet.id] !== undefined}
            <div class="alert-error">{wallet_errors[required_wallet.id].error}</div>
        {/if}
    </div>
{/each}
{#each execution_errors as error}
    <div class="alert-error">{error}</div>
{/each}
{#if $required_connections.every(value=>value.wallet)}
<button class="primary execute-button" on:click={execute}>Execute</button>
{/if}

<style>
    .label {
		font-size: 0.9rem;
        opacity: .6;
        display: block;
	}
    .wallet-connection{
        width: 100%;
        padding: 24px;
        margin-bottom: 16px;
    }
    .network-name{
        font-weight: bold;
        margin: 0 0 16px;
    }
    .wallet-info{
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .wallet-address{
        margin: 2px 0 0;
    }
    .wallet-status{
        margin: 0;
    }
    .operationcard-label{
        margin-top: 0;
        margin-bottom: 8px;
    }
    .prv-input{
        width: 100%;
    }
    .execute-button{
        width: 100%;
        justify-content: center;
    }
    .alert-error{
        margin: 16px 0 0;
    }
</style>