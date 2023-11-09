<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
    import { v4 as uuidv4 } from 'uuid';
    import ChainSelection from "./ChainSelection.svelte";

	type $$Props = NodeProps;

    export let label:string;

    let showoptions = true;

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }
</script>

<div class="card operation">
	<Handle type="target" position={Position.Left} />
        <div class="card-header">
            <img class="taskicon" style="opacity: .3;" alt="task icon" src={"/task-icons/wallet.svg"}/>
            <div>
                <p class="operationcard-label">{label}</p>
            </div>
            <button class="futuristic" on:click={()=>{showoptions = !showoptions}}>{showoptions?"hide":"show"}</button>
        </div>
        {#if showoptions}
            <slot/>
        {/if}
	<Handle type="source" position={Position.Right} />
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