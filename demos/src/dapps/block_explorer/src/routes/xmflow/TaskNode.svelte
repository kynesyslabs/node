<script>
	import { Handle, Position} from '@xyflow/svelte';
    import ChainSelection from './ChainSelection.svelte';
    import { useStore } from '@xyflow/svelte';
    import {tasks} from '$lib/chainscript';
    import cloneDeep from 'lodash/cloneDeep';
    import {get} from 'svelte/store';
    import CodeEditor from "$lib/components/CodeEditor.svelte";
    
    export let data;

    let {id, operation} = data;
    $: id = data.id;
    $: operation = data.operation;
    const task = tasks.find(t=>t.id==operation.task.type);
    const {nodes} = useStore();

    let showoptions = true;
    
    function updateChain(chainName)
    {
        let newNodes = cloneDeep(get(nodes));
        const node = newNodes.find(n=>n.id==id);
        node.data.operation.chain = chainName;
        nodes.set(newNodes);
    }

    function updateParam(paramID, value)
    {
        let newNodes = cloneDeep(get(nodes));
        const node = newNodes.find(n=>n.id==id);
        node.data.operation.task.params[paramID] = value;
        nodes.set(newNodes);
    }
</script>

<div class="card operation">
	<Handle on:connect={()=>{console.log("connect")}} type="target" position={Position.Left} />
        <div class="card-header">
            <img class="taskicon" style="opacity: .3;" alt="task icon" src={task.icon}/>
            <div>
                <p class="operationcard-label">{task.label}</p>
            </div>
            <button class="futuristic" on:click={()=>{showoptions = !showoptions}}>{showoptions?"hide":"show"}</button>
        </div>
        {#if showoptions}
            <div class="input-box">
                <label>Chain</label>
                <ChainSelection value={operation.chain} onChange={(ch)=>{updateChain(ch)}}></ChainSelection>
            </div>
            {#each task.params as param}
                <div class="input-box">
                    <label>{param.label}</label>
                    {#if param.type!=="json"}
                    <input type="text" value={operation.task.params[param.id]} on:change={(e)=>{updateParam(param.id, e.target.value)}}/>
                    {:else}
                    <CodeEditor id={id+param.label} text={operation.task.params[param.id]} onChange={(newValue)=>{updateParam(param.id, newValue)}}/>
                    {/if}
                </div>
            {/each}
            <slot/>
        {/if}
	<Handle on:connect={()=>{console.log("connect")}} type="source" position={Position.Right} />
</div>

<style>
    .operation{
        padding: 24px;
    }
    .card-header{
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
    }
    label{
        display: block;
    }
    input{
        display: block;
        width: 100%;
    }
    .input-box{
        margin: 16px 0;
    }
</style>