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