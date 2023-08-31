<script>
	import CodePreview from "$lib/components/CodePreview.svelte";
	import Combobox from "$lib/components/Combobox.svelte";
	import { faCode, faEllipsisVertical, faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { cubicInOut } from 'svelte/easing';
    import {clickOutside} from '$lib/eventhandlers/clickOutside.js'
    import {chains, universalTasks, evmTasks, mUniversalTasks, mEvmTasks} from '$lib/nocode.js';
    import "$lib/styles/crosschain/txblock.css";
	import TaskParam from "$lib/components/crosschain/TaskParam.svelte";
	import { } from "os";
	import CodeEditor from "$lib/components/CodeEditor.svelte";
    import CopyButton from "$lib/components/CopyButton.svelte";

    export let onRemove;
    export let txblock;
    export let index;

    let code = `import demos from "demos";

export default function main(){
    
}` 

    //editor (props independent) variables
    //chains
    let editorchains = [null, null];
    //mutlichain bool
    let multichain;
    //code mode bool
    let codemode = false;
    //options bool
    let options = false;
    //selected task
    let selectedTask;
    //params values
    let params = {};
    //parsedJSON
    let parsedJSON = "";

    //available tasks for selected chain
    let availableTasks = [];
    //current params for selected task
    let currentParams = [];

    function customAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scale(${0.9 + eased/10});
                    opacity: ${eased};
                    transform-origin:top right;
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




    //GET params FOR SELECTED task
    function getCurrentParams(taskid)
    {
        const currentTask = availableTasks.find((task)=>{if(task.id==taskid)return task});
        if (!currentTask) return [];
        return availableTasks.find((task)=>{if(task.id==taskid)return task}).params;
    }



    //EFFECT FOR CHANGING CHAINS
        //single chain
    $:if(!multichain)
    {
        //update props
        txblock.chain = editorchains[0];
        txblock.subchain = "dunno";
        let e = isEvmFromID(editorchains[0]);
        txblock.is_evm = e;
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
        txblock.chain = "crosschain";
        txblock.subchain = editorchains;
        let e = [isEvmFromID(txblock.subchain[0]), isEvmFromID(txblock.subchain[1])];
        txblock.is_evm = e;
        //set availableTasks based on is_evm
        if(e[0] && e[1])
            availableTasks = mUniversalTasks.concat(mEvmTasks);
        else
            availableTasks = mUniversalTasks;
    }

    //EFFECT FOR CHANGING TASK
    $: if(selectedTask)
    {
        //update current params
        currentParams = getCurrentParams(selectedTask);
        let newParams = {};
        currentParams.forEach((param)=>{
            if(!params[param.id])
            newParams[param.id] = "";
            else
            newParams[param.id] = params[param.id];
        });
        params = newParams;
        //update props
        txblock.task.type = selectedTask;
    }
    else
    {
        currentParams = [];
    }

    $:txblock.task.params = params;

    $:parsedJSON = JSON.stringify(txblock, null, 4);
</script>

<!-- IL MODO PER SMISTARE MULTICHAIN E SINGLECHAIN È operation.chain == "crosschain" => se falso rappresenta la chain selezionata invece -->
<div class="card txblock">
    <div class="txblock-header">
        <p class="txblock-header-label"><span style="font-weight:bold;">{multichain?"Multichain":"Single chain"} operation</span> <span style="opacity: .5;">on DEMOS network</span></p>
        <div class="txblock-header-header">
            <div class="txblock-header-blockchain">
                {#if multichain}
                    <Combobox onChange={(newValue)=>{editorchains[0] = newValue;}} options={chains} value={editorchains[0]}/>
                    <Combobox onChange={(newValue)=>{editorchains[1] = newValue}} options={chains} value={editorchains[1]}/>
                {:else}
                    <Combobox onChange={(newValue)=>{editorchains[0] = newValue;}} options={chains} value={editorchains[0]}/>
                {/if}
                <div class="card-ellipsis-container">
                    <button on:click={()=>{multichain=!multichain}} class={`card-ellipsis color-transition tooltip ${multichain?"selected":""}`}>
                        <span class="tooltiptext">Multichain</span>
                        <Fa icon={faPlus}></Fa>
                    </button>
                    <button on:click={()=>{codemode=!codemode}} class={`card-ellipsis color-transition tooltip ${codemode?"selected":""}`}>
                        <span class="tooltiptext">Code</span>
                        <Fa icon={faCode}></Fa>
                    </button>
                    <button on:click={()=>{if(!options)options=true}} class="card-ellipsis color-transition tooltip">
                        <span class="tooltiptext">More options</span>
                        <Fa icon={faEllipsisVertical}></Fa>
                    </button>
                    {#if options}
                        <div use:clickOutside on:click_outside={()=>{options=false}} transition:customAnimation={{duration:100, easing:cubicInOut}} class="options generic-shadow">
                            <div role={`remove operation`} on:click={()=>{options=false;onRemove();}} class="option">
                                <Fa icon={faTrash}></Fa>
                                Remove
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    </div>
    {#if (editorchains[0] !== null && !multichain) || (editorchains[0] !== null && editorchains[1] !== null && multichain)}
        <div class="txblock-body generic-shadow">
            {#if !codemode}
                <div class="txblock-input">
                    <p class="label">Select task</p>
                    <Combobox onChange={(taskid)=>{selectedTask = taskid}} options={availableTasks} value={selectedTask}/>
                </div>
                {#each currentParams as param}
                    <TaskParam label={param.label} value={params[param.id]} onChange={(newValue)=>{params[param.id]=newValue;}}></TaskParam>
                {/each}
                <div style="width: 100%;">
                    <div style="display: flex; gap:8px; align-items:center;position:relative;z-index:1000">
                        <p class="label">Output</p>
                        <CopyButton text={parsedJSON}></CopyButton>
                    </div>
                    <CodePreview text={parsedJSON} id={`code-editor${index}`}></CodePreview>
                </div>
            {:else}
                <CodeEditor text={parsedJSON} id={`code-editor${index}`}></CodeEditor>
            {/if}
        </div>
    {/if}

    
</div>