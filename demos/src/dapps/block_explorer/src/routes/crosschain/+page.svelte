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
	import ConnectWalletDialog from "./ConnectWalletDialog.svelte";
    import PageTitle from '$lib/components/PageTitle.svelte';

   //localStorage.clear("operations");

    let root = localStorage.getItem("operations")?JSON.parse(localStorage.getItem("operations")):{id:"root", items:[], type:"root"}
    $: localStorage.setItem("operations", JSON.stringify(root));

    let required_connections = []

    checkRequired(root.items)
    function checkRequired(parentArray)
    {
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
                if(required_connections.findIndex(rq=>rq.id==operation.data.chain) == -1)
                {
                    required_connections.push({id: operation.data.chain, wallet:null});
                    required_connections = required_connections;
                }
            }
        }
    }

    //loading variable
    let processing = false;

    $:if(processing)
    {
        document.documentElement.style.overflow = 'hidden';
    }
    else
    {
        document.documentElement.style.overflow = 'auto';
    }

    //prima abbiamo usato l'index, poi abbiamo usato l'id... adesso passiamo direttamente la reference
    let edit = null;
    let editparent = null;

    let editwallet = null;
    
    async function onUpdate(operation, data)
    {
        operation.data = data;
        root = root;
        required_connections = [];
        checkRequired(root.items)
    }

    function duplicateOperation(parentArray, operation)
    {
        let newOperation = cloneDeep(operation);
        newOperation.id = uuidv4();
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index+1, 0, newOperation);
        root = root;
        required_connections = [];
        checkRequired(root.items)
    }

    function deleteOperation(parentArray, operation)
    {
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index, 1);
        root = root;
        required_connections = [];
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

    let error = "";

    async function signAll(parentArray)
    {
        error = "";
        for(const operation of parentArray)
        {
            if(operation.type=="conditional")
            {
                signAll(operation.condition);
                signAll(operation.then);
                signAll(operation.else);
            }
            else if(operation.type=="pay")
            {
                try{
                    let wallet = required_connections.find(rq=>rq.id==operation.data.chain).wallet;
                    let signedPayload = await wallet.preparePay(operation.data.task.params.to, operation.data.task.params.amount)
                    operation.data.task.signedPayloads = [signedPayload];
                }
                catch(err){
                    error = err;
                }
            }
        }
    }

    async function execute()
    {
        processing = true;
        state="connect";
        demos.connect($rpcaddress);
        state="sign";
        await signAll(root.items);
        //convert the tree to a flat array
        state="create";
        XMTransactions.operation.clear();
        createAll(root.items);
        state="send";
        let result = await demos.crosschain.execute(XMTransactions.operation.get())
        console.log(result);
        processing = false;
    }

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }

    let state="editor";
</script>

<style>
    .title{
        margin: 0;
    }
    .subtitle{
        margin-bottom: 16px;
    }
    .txeditor{
        border: 1px solid var(--background3);
        width: 100%;
        margin-bottom: 64px;
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
        border: 4px solid #fff;
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
</style>

{#if processing}
    <div class="overlay">
        <div class="lds-ripple"><div></div><div></div></div> 
    </div>
{/if}
{#if edit !== null}
    <OperationEditor onSave={(data)=>{onUpdate(edit, data); edit = null; editparent=null;}} operation={edit} onClose={()=>{edit = null; editparent = null;}} onDelete={()=>{deleteOperation(editparent, edit); edit=null; editparent=null;}}/>
{/if}
{#if editwallet}
    <ConnectWalletDialog connection={editwallet} close={()=>{editwallet = null}}/>
{/if}
<div>
    <PageTitle>Crosschain transaction</PageTitle>
    <div style="display: flex; align-items:center">
        <h4 class="subtitle">Transaction editor</h4>
        {#if root.items.length > 0}
        <button on:click={()=>{root.items=[]}} class="futuristic subtitle">[clear]</button>
        {/if}
    </div>
    <div class="txeditor">
        <div class="dnd">
            <OperationCard onEdit={(op, parent)=>{edit = op; editparent=parent;}} operation={root} duplicateOperation={duplicateOperation} deleteOperation={deleteOperation}/>
        </div>
    </div>
    <h4 class="subtitle">Required wallets</h4>
    <div class="connections">
        <div class="wallet-connection card">
            <h4 class="network-name">DEMOS</h4>
            <div class="wallet-info">
                <p class="wallet-address">{trim_address(Buffer.from($wallet.keypair.publicKey).toString("hex"))}</p>
                <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
            </div>
        </div>
        {#each required_connections as required_wallet}
        <div class="wallet-connection card">
            <div class="wallet-info">
                {#if chains.find(ch=>ch.id==required_wallet.id).icon}
                <img style="margin-bottom: 20px;" alt="chain icon" src={chains.find(ch=>ch.id==required_wallet.id).icon} width="24" height="24"/>
                {/if}
                <h4 class="network-name">{chains.find(ch=>ch.id==required_wallet.id).label}</h4>
            </div>
            {#if required_wallet.wallet}
                <div class="wallet-info">
                    <p class="wallet-address">{trim_address(required_wallet.wallet.getAddress())}</p>
                    <svg class="wallet-status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="check-circle--checkmark-addition-circle-success-check-validation-add-form-tick"><path id="Subtract" fill="green" fill-rule="evenodd" d="M12 23c6.075 0 11-4.925 11-11S18.075 1 12 1 1 5.925 1 12s4.925 11 11 11Zm-.47-6.625 6-7.5-1.56-1.25-5.355 6.693-2.714-2.327-1.302 1.518 3.5 3 .786.674.646-.808Z" clip-rule="evenodd"></path></g></svg>
                </div>
            {:else}
                <button on:click={()=>{editwallet=required_wallet}} class="secondary" style="width: 100%;">Connect wallet</button>
            {/if}
        </div>
        {/each}
    </div>
    {#if error != ""}
        <div class="alert-error">{error}</div>
    {/if}
    <button on:click={execute} class="executebtn primary">Execute
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="24" width="24"><g id="end-point-arrow"><path id="Union" fill="#000000" fill-rule="evenodd" d="m14.472 17.92 -1.819 1.212 0.692 -2.073L14.697 13H1v-2h13.698l-1.353 -4.059 -0.692 -2.073 1.82 1.212 7.943 5.296 0.936 0.624 -0.936 0.624 -7.944 5.296Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    </button>
</div>