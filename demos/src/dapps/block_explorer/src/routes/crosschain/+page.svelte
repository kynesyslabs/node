<script>
	import { faLongArrowRight, faPlus } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { v4 as uuidv4 } from "uuid";
    import { cubicInOut } from 'svelte/easing';
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";
    import { SortableList } from '@jhubbardsf/svelte-sortablejs';
    import {chains} from "$lib/chainscript.js";

    class Operation{
        constructor(){
            this.chain = null;
            this.subchain = null;
            this.is_evm = false;
            this.rpc = null;
            this.task = {
                type: null,
                params: {}
            }
        }
    }

    let operations = [];

    let editing = false;

    function addOperation(){
        operations.push({id: uuidv4(), data: new Operation()})
        operations = operations;
    }

    function customAnimation(node, {duration, easing}) {
        return {
            duration,
            css: t => {
                const eased = easing(t);
                return `
                    transform: scale(${0.9 + eased/10});
                    opacity: ${eased};
                );`;
            }
        };
    }

    function onSave(data){
        if(editing == "add")
        {
            operations.push({id: uuidv4(), data: data});
            operations = operations;
        }
        editing = false;
    }
</script>

<style>
    main{
        padding: 16px;
    }
    
    .action-buttons{
        display: flex;
        justify-content: right;
        text-align: center;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
        gap: 16px;
        flex-wrap: wrap;
        max-width: 1250px;
        margin: 16px auto 0;
    }
    .operationcard-label{
        margin: 0;
    }
</style>

<main>
    {#if editing}
        <OperationEditor onSave={onSave} txblock={editing == "add"?new Operation():editing} onClose={()=>{editing = false}}/>
    {/if}
    <SortableList>
        {#each operations as operation, i (operation.id)}
            <div class="card" style="padding: 14px; margin-bottom:14px;" transition:customAnimation={{duration:350, easing:cubicInOut}}>
               <p class="operationcard-label">{operation.data.task.type} on {chains.find(c=>c.id === operation.data.chain).label}</p>
            </div>
        {/each}
    </SortableList>
    <div class="action-buttons">
        <button class="secondary color-transition" on:click={()=>{editing = "add";}}><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</button>
        <button class="primary color-transition">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></button>
    </div>
</main>