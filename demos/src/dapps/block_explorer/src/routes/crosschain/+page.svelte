<script>
	import { faLongArrowRight, faPlus } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { v4 as uuidv4 } from "uuid";
    import { cubicInOut } from 'svelte/easing';
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";
    //import { SortableList } from '@jhubbardsf/svelte-sortablejs';
    //import DragDropList from "svelte-dragdroplist";
    import {dndzone} from "svelte-dnd-action";
    import {chains, tasks} from "$lib/chainscript.js";

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

    let operations = localStorage.getItem("operations")?JSON.parse(localStorage.getItem("operations")):[];

    let editing = false;

    function onSave(data){
        if(editing == "add")
        {
            operations.push({id: uuidv4(), data: data});
            operations = operations;
        }
        editing = false;
    }

    function handleDndConsider(e) {
        operations = e.detail.items;
    }
    function handleDndFinalize(e) {
        operations = e.detail.items;
    }

    function getTaskInfo(id)
    {
        return tasks.find(t=>t.id === id);
    }

    $:localStorage.setItem("operations", JSON.stringify(operations));
</script>

<style>
    .title-container{
        display: flex;
        align-items: center;
        margin-bottom: 64px;
        gap: 16px;
        justify-content: center;
    }
    .title{
        margin: 0;
    }
    .action-buttons{
        display: flex;
        justify-content: center;
        text-align: center;
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
        gap: 16px;
        margin: 32px auto 0;
    }
    .no-operations, .operations-container{
        max-width: 616px;
        text-align: center;
        margin: 16px auto;
    }
    .operations-container{
        display: grid;
        grid-auto-flow: column;
        gap: 16px;
        grid-template-columns: auto 1fr;
        grid-template-rows: auto;
    }
    .operations-counter{
        display: grid;
        gap: 16px;
    }
    .counter-label{
        margin: 0;
        font-weight: bold;
        opacity: .4;
        display: flex;
        align-items: center;
    }
    .no-operations{
        padding: 32px;
    }
    .no-operations svg{
        opacity: .4;
        margin: 0 0 32px;
    }
    .no-operations p{
        margin: 0;
        opacity: .4;
    }
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    @media only screen and (max-width: 600px) {
        .action-buttons{
            flex-wrap: wrap;
        }
    }
    .action-button{
        flex-basis: 100%;
        max-width: 300px;
    }
    .operationcard-label{
        margin: 0;
    }
    .dnd{
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-rows: 1fr;
        gap: 16px;
    }
</style>

{#if editing}
    <OperationEditor onSave={onSave} txblock={editing == "add"?new Operation():editing} onClose={()=>{editing = false}}/>
{/if}
<div class="title-container">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="35" width="35"><g id="sign-hashtag--mail-sharp-sign-hashtag-tag"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M8.27 0.776 7.275 6.25H3v2.5h3.82l-1.181 6.5H1v2.5h4.184l-0.914 5.026 2.46 0.448 0.995 -5.474 6.46 0 -0.915 5.026 2.46 0.448 0.995 -5.474H21v-2.5h-3.82l1.181 -6.5H23v-2.5h-4.184l0.914 -5.026 -2.46 -0.448 -0.995 5.474H9.816l0.914 -5.026L8.27 0.776Zm6.37 14.474 1.181 -6.5h-6.46l-1.181 6.5 6.459 0Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    <h3 class="title">Crosschain transaction editor</h3>
</div>
{#if operations.length < 1}
<div class="card no-operations">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="128" width="128"><g id="script-1--language-programming-code"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M18 1H4v14.5h11v5h-1.5V17H1v6h17V4h1.5v5H23V1h-5ZM7 7.75h8v-1.5H7v1.5Zm8 4.5H7v-1.5h8v1.5Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    <p>No operation created yet</p>
</div>
{:else}
    <div class="operations-container">
        <div class="operations-counter">
            {#each operations as operation, i (operation.id)}
                <h3 class="counter-label">{i+1}.</h3>
            {/each}
        </div>
        <div class="dnd" use:dndzone={{items:operations}} on:consider={handleDndConsider} on:finalize={handleDndFinalize}>
            {#each operations as operation, i (operation.id)}
                <div class="card operation">
                    <img style="opacity: .3;" alt="task icon" src={getTaskInfo(operation.data.task.type).icon}/>
                    <p class="operationcard-label">{getTaskInfo(operation.data.task.type).label} on {chains.find(c=>c.id === operation.data.chain).label}</p>
                    <img width=24px alt="blockchain icon" style="margin-left: auto;" src={chains.find(c=>c.id === operation.data.chain).icon}/>
                </div>
            {/each}
        </div>
    </div>
{/if}
<div class="action-buttons">
    <button class="secondary color-transition action-button" on:click={()=>{editing = "add";}}><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</button>
    <button class="primary color-transition action-button">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></button>
</div>