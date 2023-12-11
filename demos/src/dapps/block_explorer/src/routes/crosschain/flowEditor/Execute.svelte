<script>
    import {chains} from "$lib/chainscript";
    import EVM from '$lib/demos_libs/xmlibs/chains/evm';
    import XRPL from '$lib/demos_libs/xmlibs/chains/xrpl';
    import XMTransactions from "$lib/demos_libs/XMTransactions.js";
	import { useStore } from "@xyflow/svelte";
    import cloneDeep from 'lodash/cloneDeep';
	import XMWalletConnectionCard from "../xM_WalletConnectionCard.svelte";

    const {nodes, edges} = useStore();

    let chainobjs={
        "evm":EVM,
        "xrpl":XRPL
    }

    export let required_connections
    let editing = false;
    /**Every key is a chain*/
    let wallet_errors = {};
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
            connection.wallet = mychainwallet;
            return true;
        }
        catch(err){
            wallet_errors[connection.id] = err;
            return false;
        }
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
            rejectPromise(()=>{
                wallet_errors[targetnode.data.operation.chain] = err;
            });
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
        }).catch((err_callback)=>{
            err_callback();
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
    <XMWalletConnectionCard chain={required_wallet} {connectWallet} error={wallet_errors[required_wallet.id]} />
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
    .execute-button{
        width: 100%;
        justify-content: center;
    }
    .alert-error{
        margin: 16px 0 0;
    }
</style>