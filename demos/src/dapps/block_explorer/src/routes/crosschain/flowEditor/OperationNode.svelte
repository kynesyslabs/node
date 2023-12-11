<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { Writable } from 'svelte/store';
    import {chains, tasks} from '$lib/chainscript.js';
    import { v4 as uuidv4 } from 'uuid';

	type $$Props = NodeProps;

	export let data;

    let node;
    let taskinfo;
    let chaininfo;
    let inputid = uuidv4();

	const { operation } = data;
    //cerca le info per la grafica se è il caso
    $:if(operation.type!=="conditional" && operation.data)
    {
        chaininfo = chains.find(c=>c.id === operation.data.chain);
    }
    $:if(operation.type!=="conditional"&&operation.type!=="root")
    {
        taskinfo = tasks.find(t=>t.id === operation.type);
    }

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }
</script>

<div class="card operation">
	<Handle type="target" position={Position.Left} />
<div class="card operation">
        <!--{JSON.stringify(node)}-->
        {#if chaininfo && taskinfo}
            <img style="opacity: .3;" alt="task icon" src={taskinfo.icon}/>
            <div>
                <p class="operationcard-label">{taskinfo.label} on {chaininfo.label}</p>
                <div class="params-preview">
                    {#each taskinfo.params as param}
                        {#if operation.data.task.params[param.id]&&param.type!=="json"}
                        <p class="ellipsis">{param.label}: <span style="font-weight: normal;">{param.type=="address"?trim_address(operation.data.task.params[param.id]):operation.data.task.params[param.id]}</span></p>
                        {/if}
                    {/each}
                </div>
            </div>
            {#if chaininfo.icon}
                <img width=24px alt="blockchain icon" style="margin-left: auto;" src={chaininfo.icon}/>
            {/if}
        {:else if taskinfo}
            <img style="opacity: .3;" alt="task icon" src={taskinfo.icon}/>
            <div>
                <p class="operationcard-label">{taskinfo.label}</p>
            </div>
        {/if}
        <!--<div style={`position: relative; margin-left:${!chaininfo?.icon?"auto":"0"};`}>
            <button on:click={()=>{menuopen = true;}} class="shallow color-transition"><Fa icon={faEllipsisV}></Fa></button>
            {#if menuopen}
                <div use:clickOutside on:click_outside={()=>{menuopen = false}} transition:toprightbudino={{duration:200}} class="dialog">
                    <button on:click={()=>{onEdit(operation, parent)}} class="dialog-option color-transition">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="pen-1--content-creation-edit-pen-write"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M20.5 9 15 3.5 17.5 1 23 6.5 20.5 9ZM11 1.586l0.707 0.707 2.25 2.25L14 4.5l5.5 5.5 -9.5 9.5L4.5 14l8.043 -8.043L11 4.414 5.707 9.707 4.293 8.293l6 -6L11 1.586Zm-8 18V15.5l0.5 -0.5L9 20.5l-0.5 0.5H4.414l-1.707 1.707 -1.414 -1.414L3 19.586Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                        Edit
                    </button>
                    {#if duplicateOperation}
                    <button on:click={()=>{duplicateOperation(parent, operation); menuopen=false}} class="dialog-option color-transition">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="copy-document"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M3 1H2v19h2V3h11V1H3Zm12.25 9.5V4.75h-9.5v18h16v-11.5h-6.5v-0.75Zm1.5 -0.75v-5h0.06l4.94 4.94v0.06h-5Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                        Duplicate
                    </button>
                    {/if}
                    <button on:click={()=>{deleteOperation(parent, operation)}} class="dialog-option color-transition">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="recycle-bin-2--remove-delete-empty-bin-trash-garbage"><path class="color-transition" id="Subtract" fill="#ffffff" fill-rule="evenodd" d="M9.17 5a3.001 3.001 0 0 1 5.66 0H9.17ZM7.1 5a5.002 5.002 0 0 1 9.8 0H23v2h-2v16H3V7H1V5h6.1Zm0.4 13.5v-8h2v8h-2Zm7 -8v8h2v-8h-2Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                        Delete
                    </button>
                </div>
            {/if}
        </div>-->
    </div>
	<Handle type="source" position={Position.Right} />
</div>

<style>
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
    }
</style>