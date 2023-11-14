<script>
	import { Handle, Position} from '@xyflow/svelte';
    import ChainSelection from './ChainSelection.svelte';
    import { useStore } from '@xyflow/svelte';
    
    export let data;

    $:console.log(data);
    const {nodes} = useStore();
    export let label;

    let showoptions = true;
    
    /*function updateChain(chainName)
    {
        nodes.update()
    }*/
    console.log($nodes);
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
                <ChainSelection value={data.chain} onChange={(ch)=>{data.chain=ch}}></ChainSelection>
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