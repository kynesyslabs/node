<script>
    import {chains, tasks} from '$lib/chainscript.js';
	import TaskParam from "./TaskParam.svelte";
	import ChainSelection from "$lib/components/inputs/ChainSelection.svelte";
    import {budinofade, budinotraslato} from '$lib/transitions.js';
    import {cloneDeep} from 'lodash';
    import {Operation} from '$lib/chainscript.js';
    import "$lib/styles/crosschain/operationeditor.css"


    export let onClose;
    export let onDelete;
    export let onSave;
    export let operation;

    let txblock = operation.data?operation.data:new Operation({tasktype: operation.type});
    console.log(txblock);

    //flags to check if all the fields are filled: [chain, task, params]
    let complete = [false, true, false];

    //editor (props independent) variables
    //chains
    let editorchains = txblock.chain=="crosschain"?txblock.subchain:[txblock.chain, null];
    //mutlichain bool
    let multichain = txblock.chain=="crosschain";
    //params values
    let params = txblock.task.params;
    //txblock clone for editing
    let txblockClone = cloneDeep(txblock);

    //error variable for display
    let errorDisplay = null;

    //current params for selected task
    let currentParams = tasks.find(t=>t.id === txblock.task.type).params;

    //utils per mostrare graficamente le informazioni
    let taskinfo;
    $:if(txblock.task.type)
    {
        taskinfo = tasks.find(t=>t.id === txblock.task.type);
    }
    let chainflag;
    $: chainflag = (editorchains[0] !== null && !multichain) || (editorchains[0] !== null && editorchains[1] !== null && multichain)

    //FUNCTION TO SET is_evm IN txblock
    function isEvmFromID(id)
    {
        if(!id)return false;
        return chains.find((chain)=>{if(chain.id==id)return chain}).is_evm;
    }

    function hasEVMconstraint(task)
    {
        return tasks.find(t=>t.id === task).constraints.includes("evm");
    }

    //EFFECT FOR CHANGING CHAINS –––– SET AVAILABLE TASKS
        //single chain
    $:if(!multichain)
    {
        //update props
        txblockClone.chain = editorchains[0];
        txblockClone.subchain = "dunno";
        let e = isEvmFromID(editorchains[0]);
        txblockClone.is_evm = e;
        //flag filled
        complete[0] = editorchains[0] !== null;
    }
        //multichain
    else
    {
        //update props
        txblockClone.chain = "crosschain";
        txblockClone.subchain = editorchains;
        let e = [isEvmFromID(editorchains[0]), isEvmFromID(editorchains[1])];
        txblockClone.is_evm = e;
        //flag filled
        complete[0] = editorchains[0] !== null && editorchains[1] !== null;
    }

    $:txblockClone.task.params = params;

    //EFFECT FOR CHANGING PARAMS
    $:complete[2] = currentParams.every((param)=>
    {
        if(!param.required)
        {
            return true;
        }
        if(param.type == "json")
        {
            try
            {
                JSON.parse(params[param.id]);
            }
            catch(e)
            {
                return false;
            }
        }
        return params[param.id] !== undefined && params[param.id] !== null && params[param.id] !== ""
    });


    //WALLETS LOGIC
    //chains wallets
    let wallets = [null, null];

    //connect wallet 
    /*$:if()
    {
        if(editorchains[0] == "eth")
        {
            const ethereum = MMSDK.getProvider(); // You can also access via window.ethereum
            let acc = ethereum.request({method:'eth_requestAccounts'}).then((res)=>{
                console.log(res);
            })
        }
    }*/
</script>

<div class="modal-background" transition:budinofade>
    <!-- IL MODO PER SMISTARE MULTICHAIN E SINGLECHAIN È operation.chain == "crosschain" => se falso rappresenta la chain selezionata invece -->
    <div transition:budinotraslato class="modal-txblock">
        <!--{#if editorchains[0] == "eth" && wallets[0] == null}
            <h3 class="operationcard-label">Connect Ethereum wallet</h3>
            <button class="primary" style="display: flex; align-items:center; gap:8px;"><p style="margin:4px 0 0;">Connect metamask</p> <img width="32" height="32" src={metamask} alt="metamask icon"/></button>
        {:else}-->
            <div class="txblock">
                <div class="opeditor-title">
                    <img style="opacity: .3;" alt="task icon" src={taskinfo.icon}/>
                    <div>
                        <h3 class="operationcard-label">{taskinfo.label} task <span style="opacity: .6;">on DEMOS network</span></h3>
                    </div>
                </div>
                <div class="opeditor-chain-selection">
                    {#if multichain}
                        <ChainSelection evmTask={hasEVMconstraint(taskinfo.id)} open={!chainflag} onOpen = {()=>{chainflag = false}} onChange={(newValue)=>{editorchains[0] = newValue;}} value={editorchains[0]}/>
                        <ChainSelection evmTask={hasEVMconstraint(taskinfo.id)} open={!chainflag} onOpen = {()=>{chainflag = false}} onChange={(newValue)=>{editorchains[1] = newValue;}} value={editorchains[1]}/>
                    {:else}
                        <ChainSelection evmTask={hasEVMconstraint(taskinfo.id)} open={!chainflag} onOpen = {()=>{chainflag = false}} onChange={(newValue)=>{editorchains[0] = newValue;}} value={editorchains[0]}/>
                    {/if}
                </div>
                {#if chainflag}
                    <div class="opeditor-params generic-shadow">
                        {#each currentParams as param}
                            <TaskParam required={param.required} label={param.label} value={params[param.id]} onChange={(newValue)=>{params[param.id]=newValue;}} type={param.type}></TaskParam>
                        {/each}
                    </div>
                {/if}
                {#if errorDisplay}
                    <div class="alert-error">
                        <p>{errorDisplay}</p>
                    </div>
                {/if}
                <div class="tx-buttons">
                    <button class="secondary" on:click={()=>{operation.data.chain?onClose():onDelete()}}>Cancel</button>
                    <button disabled={!(complete[0]&&complete[1]&&complete[2])} on:click={async()=>{
                            onSave(txblockClone)
                    }}
                    class="primary tooltip">
                        {#if !(complete[0]&&complete[1]&&complete[2])}
                        <span class="tooltiptext">Fill required fields</span>
                        {/if}
                    Save</button>
                </div>
            </div>
        <!--{/if}-->
    </div>
</div>