<script>
    import { cubicInOut } from 'svelte/easing';
    import {chains, universalTasks, evmTasks, mUniversalTasks, mEvmTasks, tasks} from '$lib/chainscript.js';
	import TaskParam from "$lib/components/crosschain/TaskParam.svelte";
	import ChainSelection from "$lib/components/inputs/ChainSelection.svelte";
    import {budinofade} from '$lib/transitions.js';

    export let onClose;
    export let onDelete;
    export let onSave;
    export let txblock;

    //flags to check if all the fields are filled: [chain, task, params]
    let complete = [false, true, false];
    //flags to check if card existed [chain, params] 
    let propscomplete = [false, false];
    propscomplete[0] = txblock.chain !== null;
    for(let i = 0; i < Object.values(txblock.task.params).length; i++)
    {
        if(Object.values(txblock.task.params)[i] !== "" && Object.values(txblock.task.params)[i])
        {
            propscomplete[1] = true;
            break;
        }
    }

    //editor (props independent) variables
    //chains
    let editorchains = txblock.chain=="crosschain"?txblock.subchain:[txblock.chain, null];
    //mutlichain bool
    let multichain = txblock.chain=="crosschain";
    //params values
    let params = txblock.task.params;
    //parsedJSON
    let parsedJSON = "";
    //txblock clone
    let txblockClone = JSON.parse(JSON.stringify(txblock));

    //available tasks for selected chain
    let availableTasks = [];
    //current params for selected task
    let currentParams = tasks.find(t=>t.id === txblock.task.type).params;

    //utils
    let taskinfo;
    $:if(txblock.task.type)
    {
        taskinfo = tasks.find(t=>t.id === txblock.task.type);
    }
    let chainflag;
    $: chainflag = (editorchains[0] !== null && !multichain) || (editorchains[0] !== null && editorchains[1] !== null && multichain)

    function dialogAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: translate(-50%, -50%) scale(${0.9 + eased/10});
                    transform-origin:center;
                );`;
            }
        };
    }

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
        //set availableTasks based on is_evm
        if(e)
            availableTasks = universalTasks.concat(evmTasks);
        else
            availableTasks = universalTasks;
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
        //set availableTasks based on is_evm
        if(e[0] && e[1])
            availableTasks = mUniversalTasks.concat(mEvmTasks);
        else
            availableTasks = mUniversalTasks;
    }

    $:txblockClone.task.params = params;

    //EFFECT FOR CHANGING PARAMS
    $:complete[2] = currentParams.every((param)=>{return params[param.id] !== undefined && params[param.id] !== null && params[param.id] !== ""});

    $:parsedJSON = JSON.stringify(txblockClone, null, 4);
</script>

<style>
    .opeditor-title{
        display: flex;
        align-items: center;
        margin-bottom: 24px;
        gap: 16px;
    }

    .opeditor-title h3{
        margin: 0;
    }

    .opeditor-chain-selection{
        margin-bottom: 24px;
        width: 500px;
        max-width: 100%;
    }

    .opeditor-params{
        width: 100%;
        display: grid;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
        grid-template-columns: 1fr 1fr;
    }

    .modal-txblock{
        background-color: var(--background-min);
        position: fixed;
        top: 50%;
        left: 50%;
        width: fit-content;
        max-width: calc(100% - 32px);
        max-height: calc(100dvh - 48px);
        z-index: 1000;
        padding: 64px;
        overflow: auto;
        transform: translate(-50%, -50%) scale(1);
    }

    @media (max-width: 768px){
        .modal-txblock{
            padding: 32px;
        }
    }

    .modal-background{
        position: fixed;
        top: 0;
        left: 0;
        width: 100dvw;
        height: 100dvh;
        background-color: rgba(0,0,0,.5);
        z-index: 999;
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .txblock{
        max-width: 1250px;
        margin: auto;
    }

    .tx-buttons{
        display: flex;
        gap: 16px;
        margin-top: 16px;
        justify-content: flex-end;
    }
</style>

<div class="modal-background" transition:budinofade>
    <!-- IL MODO PER SMISTARE MULTICHAIN E SINGLECHAIN È operation.chain == "crosschain" => se falso rappresenta la chain selezionata invece -->
    <div transition:dialogAnimation={{
        duration: 350,
        easing: cubicInOut
    }} class="modal-txblock">
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
                        <TaskParam label={param.label} value={params[param.id]} onChange={(newValue)=>{params[param.id]=newValue;}}></TaskParam>
                    {/each}
                </div>
            {/if}
            <div class="tx-buttons">
                <button class="secondary" on:click={()=>{propscomplete[0]&&propscomplete[1]?onClose():onDelete()}}>Cancel</button>
                <button disabled={!(complete[0]&&complete[1]&&complete[2])} on:click={onSave(txblockClone)} class="primary tooltip">
                    {#if !(complete[0]&&complete[1]&&complete[2])}
                    <span class="tooltiptext">Fill all fields</span>
                    {/if}
                Save</button>
            </div>
        </div>
    </div>
</div>