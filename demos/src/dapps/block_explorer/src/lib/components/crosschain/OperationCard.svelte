<script>
    import {faEllipsisV} from '@fortawesome/free-solid-svg-icons';
    import Fa from 'svelte-fa';
    import {chains, tasks} from '$lib/chainscript.js';
    import {toprightbudino} from '$lib/transitions.js';
    import {clickOutside} from '$lib/eventhandlers.js';
    import OperationEditor from '$lib/components/crosschain/OperationEditor.svelte';

    export let operation;
    export let index;
    export let onUpdate;

    let taskinfo = tasks.find(t=>t.id === operation.data.task.type);
    let chaininfo = chains.find(c=>c.id === operation.data.chain);
    let menuopen = false;
    let editing = false;

    function onSave(data)
    {
        onUpdate(index, data);
        editing = false;
    }
</script>
<style>
    .operationcard-label{
        margin: 0;
    }
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .dialog{
        position: absolute;
        top: 0;
        right: 0;
        background: var(--background2-min);
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    }
    .dialog-option{
        padding: 16px;
        width: 100%;
        text-align: center;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 150px;
        font-size: 1rem;
    }
    .dialog-option:hover{
        background-color: var(--accent);
        color: black;
    }
    .dialog-option svg path{
        fill: var(--accent);
    }
    .dialog-option:hover svg path{
        fill: black;
    }
</style>

{#if editing}
    <OperationEditor onSave={onSave} txblock={operation} onClose={()=>{editing = false}}/>
{/if}
<div class="card operation">
    <img style="opacity: .3;" alt="task icon" src={taskinfo.icon}/>
    <p class="operationcard-label">{taskinfo.label} on {chaininfo.label}</p>
    <img width=24px alt="blockchain icon" style="margin-left: auto;" src={chaininfo.icon}/>
    <button on:click={()=>{menuopen = true;}} class="shallow color-transition"><Fa icon={faEllipsisV}></Fa></button>
    {#if menuopen}
        <div use:clickOutside on:click_outside={()=>{menuopen = false}} transition:toprightbudino={{duration:200}} class="dialog">
            <button on:click={()=>{editing = true}} class="dialog-option color-transition">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="pen-1--content-creation-edit-pen-write"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M20.5 9 15 3.5 17.5 1 23 6.5 20.5 9ZM11 1.586l0.707 0.707 2.25 2.25L14 4.5l5.5 5.5 -9.5 9.5L4.5 14l8.043 -8.043L11 4.414 5.707 9.707 4.293 8.293l6 -6L11 1.586Zm-8 18V15.5l0.5 -0.5L9 20.5l-0.5 0.5H4.414l-1.707 1.707 -1.414 -1.414L3 19.586Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                Edit
            </button>
            <button class="dialog-option color-transition">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="recycle-bin-2--remove-delete-empty-bin-trash-garbage"><path class="color-transition" id="Subtract" fill="#ffffff" fill-rule="evenodd" d="M9.17 5a3.001 3.001 0 0 1 5.66 0H9.17ZM7.1 5a5.002 5.002 0 0 1 9.8 0H23v2h-2v16H3V7H1V5h6.1Zm0.4 13.5v-8h2v8h-2Zm7 -8v8h2v-8h-2Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                Delete
            </button>
        </div>
    {/if}
</div>