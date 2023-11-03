<script>
    import { Svelvet, Minimap } from 'svelvet';
	import OperationNode from './OperationNode.svelte';
    import {Operation} from "$lib/chainscript.js";
    import { v4 as uuidv4 } from 'uuid';
	import { onMount } from 'svelte';
    import Drawer from "./Drawer.svelte"
    import {megabudino} from "$lib/transitions.js";
	import StartNode from './StartNode.svelte';

    let theme = "dark";
    onMount(()=>{
        //check system theme
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if(dark)
        {
            theme = "dark";
        }
        else
        {
            theme = "light";
        }
    })

    let nodes = []
    let connections = {
        start:[]
    }
    let draweropen = false;

    function closeDrawer(){
        draweropen = false;
    }

    function addNode(ev)
    {
        const newID = uuidv4();
        console.log(ev);
        nodes.push({id:newID, label:"Pay", type:"pay", position:ev.detail.cursor, source:ev.detail.source, data:new Operation({tasktype:"pay"})})
        connections[ev.detail.source.node].push(newID)
        connections = connections;
        nodes=nodes;
        console.log(connections.start);
    }
</script>
<style>
    .add-button{
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 1000;
        border-radius: 50%;
        width: auto;
        padding: 16px;
    }
</style>

<div style="height:100dvh;">
    <Drawer open={draweropen} close={closeDrawer} addNode={addNode}/>
    <!--{#if !draweropen}
    <button transition:megabudino on:click={()=>{draweropen = true}} class="primary add-button">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="24" height="24"><g id="add-1--expand-cross-buttons-button-more-remove-plus-add-+-mathematics-math"><path id="Union" fill="var(--background)" fill-rule="evenodd" d="M10 14v9h4v-9h9v-4h-9V1h-4v9H1v4h9Z" clip-rule="evenodd"></path></g></svg>
    </button>
    {/if}-->
    <Svelvet id="my-canvas" width="100%" controls theme={theme} on:edgeDrop={addNode}>
        <StartNode connections={connections.start}></StartNode>
        <Minimap corner="NE" slot="minimap"/>
        {#each nodes as node}
            <OperationNode id={node.id} operation={node} position={node.position} source={node.source}/>
        {/each}
        <!--<OperationNode operation={{id:uuidv4(), label:"Pay", type:"pay", data:new Operation({tasktype:"pay"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Pay", type:"pay", data:new Operation({tasktype:"pay"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Read Contract", type:"contract_read", data:new Operation({tasktype:"contract_read"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Read Contract", type:"contract_read", data:new Operation({tasktype:"contract_read"})}}/>
        <ConditionalNode/>
        <EqualsNode/>-->
    </Svelvet>
</div>