<script>
	import OperationEditor from "./OperationEditor.svelte";
	import OperationCard from "./OperationCard.svelte";
    import XMTransactions from "$lib/demos_libs/XMTransactions.js";
    import demos from "$lib/demos.js"
    import { rpcaddress, wallet }  from '$lib/env.js';
    import { v4 as uuidv4 } from 'uuid'; 
    import cloneDeep from 'lodash/cloneDeep';
    import { Buffer } from "buffer";
    import {chains} from "$lib/chainscript.js";
    import PageTitle from '$lib/components/PageTitle.svelte';
    import { fly } from "svelte/transition";
    import XMWalletConnectionCard from "../../lib/components/xM_WalletConnectionCard.svelte";
    import EVM from '$lib/demos_libs/xmlibs/chains/evm';
    import XRPL from '$lib/demos_libs/xmlibs/chains/xrpl';

    //Avoid version conflicts
    const version = "1.01";
    if(localStorage.getItem("version") != version)
    {
        localStorage.removeItem("operations");
        localStorage.setItem("version", version);
    }

    //Save
    let root = localStorage.getItem("operations")?JSON.parse(localStorage.getItem("operations")):{id:"root", items:[], type:"root"}
    $: localStorage.setItem("operations", JSON.stringify(root));

    /**Required chains and their wallets
     * @type {{id: string, wallet: any}[]} */
    let required_connections = []
    /** Used when checking requirements. It contains only the list of the required chains.
     * @type {string[]}*/
    let temp_required = [];

    /** Errors relative to required wallets. Every object key rapresents a chain. */
    let wallet_errors = {};

    let error = "";

    checkRequired(root.items)
    function checkRequired(parentArray)
    {
        if(parentArray == root.items)
            temp_required = [];
        error = "";
        for(const operation of parentArray)
        {
            if(operation.type=="conditional")
            {
                checkRequired(operation.condition);
                checkRequired(operation.then);
                checkRequired(operation.else);
            }
            else if(operation.type=="pay")
            {
                if(temp_required.findIndex(rq=>rq.id==operation.data.chain) == -1)
                {
                    temp_required.push(operation.data.chain);
                    temp_required = temp_required;
                }
            }
        }
        if(parentArray == root.items)
            consolidateRequired();
    }

    function consolidateRequired(){
		let required_copy = cloneDeep(required_connections);
		//remove connections that are not required anymore
		required_copy.forEach((rq, index) => {
			//find the index of the chain in the temp array
			const connection_index = temp_required.findIndex(temp_chain=>temp_chain==rq.id);
			//if chain does not exist in the temp array, remove it from the actual one
			if(connection_index == -1)
			{
				required_copy.splice(index, 1);
			}
		});
		//add connections that are required
		temp_required.forEach((chain) =>{
			const chain_index = required_copy.findIndex(rq=>rq.id==chain);
			if(chain_index == -1)
			{
				required_copy.push({id:chain, wallet:null});
			}
		})
		required_connections = required_copy;
	}


    //loading variable
    let processing = false;
    let success = false;
    let result;

    $:if(success)
    {
        setTimeout(()=>{
            success = false;
        }, 3000)
    }

    $:if(processing)
    {
        document.documentElement.style.overflow = 'hidden';
    }
    else
    {
        document.documentElement.style.overflow = 'auto';
    }

    //reference to the operation being edited
    let edit = null;
    //reference to the parent of the operation being edited
    let editparent = null;
    
    async function onUpdate(operation, data)
    {
        operation.data = data;
        root = root;
        checkRequired(root.items)
    }

    function duplicateOperation(parentArray, operation)
    {
        let newOperation = cloneDeep(operation);
        newOperation.id = uuidv4();
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index+1, 0, newOperation);
        root = root;
        checkRequired(root.items)
    }

    function deleteOperation(parentArray, operation)
    {
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index, 1);
        root = root;
        checkRequired(root.items);
    }

    const conditionOptions = [
        {id:"equals", label:"=="},
        {id:"greater", label:">"},
        {id:"less", label:"<"},
        {id:"greaterorequals", label:">="},
        {id:"lessorequals", label:"<="},
        {id:"notequals", label:"!="},
    ]

    function createAll(parentArray)
    {
        for(const operation of parentArray)
        {
            if(operation.type=="conditional")
            {
                XMTransactions.operation.create_condition(operation.id, "if", `${operation.condition[0].id} ${conditionOptions.find(s=>s.id == operation.symbol).label} ${operation.input}`, operation.then.map(op=>op.id), operation.else.map(op=>op.id));
                createAll(operation.condition);
                createAll(operation.then);
                createAll(operation.else);
            }
            else
            {
                XMTransactions.operation.create(operation.id, operation.data.chain, operation.data.subchain, operation.data.is_evm, operation.data.rpc, operation.data.task, operation.data.conditional);
            }
        }
    }

    async function signAll(parentArray, resolve, reject)
    {
        error = "";
        for(const operation of parentArray)
        {
            if(operation.type=="conditional")
            {
                await signAll(operation.condition, resolve, reject);
                await signAll(operation.then, resolve, reject);
                await signAll(operation.else, resolve, reject);
            }
            else if(operation.type=="pay")
            {
                try{
                    let wallet = required_connections.find(rq=>rq.id==operation.data.chain).wallet;
                    let signedPayload = await wallet.preparePay(operation.data.task.params.to, operation.data.task.params.amount)
                    operation.data.task.signedPayloads = [signedPayload];
                }
                catch(err){
                    reject(err);
                }
            }
        }
        if(parentArray == root.items)
            resolve();
    }

    async function execute()
    {
        processing = true;
        state="connect";
        demos.connect($rpcaddress);
        state="sign";
        const signPromise = new Promise((resolve, reject)=>{
            signAll(root.items, resolve, reject);
        })
        try{
            await signPromise;
        }
        catch(err){
            error = err;
            processing = false;
            return;
        }
        //convert the tree to a flat array
        state="create";
        XMTransactions.operation.clear();
        createAll(root.items);
        state="send";
        let executionresult = await demos.crosschain.execute(XMTransactions.operation.get())
        processing = false;
        success = true;
        result = executionresult.response;
    }

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }

    let state="editor";

    let chainobjs={
        "evm":EVM,
        "xrpl":XRPL
    }

    async function connectWallet(connection, prvkey)
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
            required_connections.find(cs=>cs.id == connection.id).wallet = mychainwallet;
            required_connections = required_connections;
            return true;
        }
        catch(err){
            error = err;
            return false
        }
    }
</script>

<!--success dialog-->
{#if success}
    <div transition:fly class="success-dialog">Success!</div>
{/if}
{#if processing}
    <div class="overlay">
        <div class="lds-ripple"><div></div><div></div></div> 
    </div>
{/if}
{#if edit !== null}
    <OperationEditor onSave={(data)=>{onUpdate(edit, data); edit = null; editparent=null;}} operation={edit} onClose={()=>{edit = null; editparent = null;}} onDelete={()=>{deleteOperation(editparent, edit); edit=null; editparent=null;}}/>
{/if}
<div>
    <PageTitle>xM</PageTitle>
    <div style="display: flex; align-items:center">
        <h4 class="subtitle">Build a Cross-Chain Transaction</h4>
        {#if root.items.length > 0}
        <button on:click={()=>{root.items=[]}} class="futuristic subtitle">[clear]</button>
        {/if}
    </div>
    <div class="txeditor">
        {#if root.items.length == 0}
        <div class="instructions">
            <svg width="64" height="64" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="var(--color)" fill-rule="evenodd" d="M1 1h3.17v2H3v1.171H1V1Zm13.58 0v3.17l-2 0V3h-1.172V1h3.171ZM9.236 1H6.342l0 2h2.895V1ZM1 14.58v-3.17h2v1.17h1.171v2H1Zm0-5.343V6.342h2l0 2.895H1Zm11.95 3.712 2.01 9.046 2.26-2.262L20.489 23 23 20.487l-3.266-3.266 2.261-2.262-2.913-.647-6.133-1.363Zm6.132-7.446H5.502v13.58h7.274l-1.802-8.11 8.108 1.802V5.503Z" clip-rule="evenodd"></path></svg>
            <p style="margin-bottom: 0;">Drop blocks here and start building your transaction</p>
        </div>
        {/if}
        <div class="dnd">
            <OperationCard triggerUpdate={()=>{root = root}} onEdit={(op, parent)=>{edit = op; editparent=parent;}} operation={root} duplicateOperation={duplicateOperation} deleteOperation={deleteOperation}/>
        </div>
    </div>
    <h4 class="subtitle">Required Wallets</h4>
    <div class="connections">
        <div class="wallet-connection card">
            <h4 class="network-name">DEMOS</h4>
            <div class="wallet-info">
                <p class="wallet-address">{trim_address(Buffer.from($wallet.keypair.publicKey).toString("hex"))}</p>
                <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
            </div>
        </div>
        {#each required_connections as required_wallet}
            <XMWalletConnectionCard chain={required_wallet} {connectWallet} error={wallet_errors[required_wallet.id]} />
        {/each}
    </div>
    {#if error != ""}
        <div class="alert-error">{error}</div>
    {/if}

    {#if required_connections.every(value=>value.wallet) && !error}
        <button class="primary executebtn" on:click={execute}>Execute</button>
    {:else}
        <button disabled class="executebtn primary tooltip"><span class="tooltiptext">{error?"Resolve error":"Connect all chains"}</span>Execute</button>
    {/if}

    {#if result}
        <h4 class="subtitle">Result</h4>
        <div class="card" style="padding: 24px;">
            {result}
        </div>
    {/if}
</div>

<style>
    .subtitle{
        margin-bottom: 16px;
    }
    .txeditor{
        border: 1px solid var(--background3);
        width: 100%;
        margin-bottom: 64px;
        position: relative;
    }
    .dnd{
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-rows: 1fr;
        gap: 16px;
        padding: 24px;
    }
    .connections{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 24px;
        margin-bottom: 64px;
    }
    @media screen and (max-width: 1250px)
    {
        .connections{
            grid-template-columns: 1fr 1fr;
        }
    }
    @media screen and (max-width: 800px)
    {
        .connections{
            grid-template-columns: 1fr;
        }
    }
    .wallet-connection{
        width: 100%;
        padding: 24px;
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
    .executebtn{
        margin-left: auto;
        margin-top: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .overlay{
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background-color: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    }
    .lds-ripple {
        display: inline-block;
        position: relative;
        width: 80px;
        height: 80px;
    }
    .lds-ripple div {
        position: absolute;
        border: 4px solid var(--color);
        opacity: 1;
        border-radius: 50%;
        animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite;
    }
    .lds-ripple div:nth-child(2) {
        animation-delay: -0.5s;
    }
    @keyframes lds-ripple {
        0% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 0;
        }
        4.9% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 0;
        }
        5% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 1;
        }
        100% {
            top: 0px;
            left: 0px;
            width: 72px;
            height: 72px;
            opacity: 0;
        }
    }
    .success-dialog{
        position: fixed;
        right: 16px;
        bottom: 16px;
        padding: 16px;
        background-color: #29b86b;
        z-index: 10001;
    }
    .instructions{
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        opacity: .4;
        text-align: center;
    }
</style>
