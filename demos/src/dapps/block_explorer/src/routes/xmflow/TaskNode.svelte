<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	
    type $$Props = NodeProps;
    
    export let data;

    console.log(data);

    export let label:string;

    let showoptions = true;
</script>

<div class="card operation">
	<Handle on:connect={()=>{console.log("connect")}} type="target" position={Position.Left} />
        <div class="card-header">
            <img class="taskicon" style="opacity: .3;" alt="task icon" src={"/task-icons/wallet.svg"}/>
            <div>
                <p class="operationcard-label">{label}</p>
            </div>
            <button class="futuristic" on:click={()=>{showoptions = !showoptions}}>{showoptions?"hide":"show"}</button>
        </div>
        {#if showoptions}
            <div class="input-box">
                <label>Chain</label>
                <!--<ChainSelection value={chain} onChange={updateChain}></ChainSelection>-->
            </div>
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