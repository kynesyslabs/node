<script>
    import {faEllipsisV} from '@fortawesome/free-solid-svg-icons';
    import Fa from 'svelte-fa';
    import {chains, tasks} from '$lib/chainscript.js';
    import {toprightbudino} from '$lib/transitions.js';
    import {clickOutside} from '$lib/eventhandlers.js';
    import {dndzone} from "svelte-dnd-action";
	import { flip } from "svelte/animate";
    import Combobox from '$lib/components/inputs/Combobox.svelte';
    import {Operation} from '$lib/chainscript.js';
	import CardMenu from '$lib/components/CardMenu.svelte';

    export let operation;
    export let duplicateOperation;
    export let deleteOperation;
    export let onEdit;
    export let parent;
    export let triggerUpdate;
    
    let taskinfo;
    let chaininfo;

    let conditionOptions = [
        {id:"equals", label:"=="},
        {id:"greater", label:">"},
        {id:"less", label:"<"},
        {id:"greaterorequals", label:">="},
        {id:"lessorequals", label:"<="},
        {id:"notequals", label:"!="},
    ]
    //cerca le info per la grafica se è il caso
    $:if(operation.type!=="conditional" && operation.data)
    {
        chaininfo = chains.find(c=>c.id === operation.data.chain);
    }
    $:if(operation.type!=="conditional"&&operation.type!=="root")
    {
        taskinfo = tasks.find(t=>t.id === operation.type);
    }
    let menuopen = false;                       

    function consider(e, key) {
        operation[key] = e.detail.items;
    }
    function finalize(e, key) {
        operation[key] = e.detail.items;
        createTask(e, key);
    }

    function createTask(e, key){
        triggerUpdate();
        if(e.detail.info.trigger === "droppedIntoAnother" || !e.detail.info.id)
        {
            return;
        }
        let thisop = e.detail.items.find(op=>op.id===e.detail.info.id);
        if(!thisop)
            return;
        //apri l'editor se operation data non esiste e se non è un conditional
        if(thisop.type == "conditional")
            return;
        //se è figlio di un conditional setta il flag true, altrimenti false
        if(!thisop.data)
        {
            thisop.data = new Operation({tasktype:thisop.type});
            if(key!=="items")
                thisop.data.conditional = true
            else
                thisop.data.conditional = false
            onEdit(thisop, operation[key]);
        }
        else
        {
            if(key!=="items")
                thisop.data.conditional = true
            else
                thisop.data.conditional = false
        }
    }

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }
</script>

{#if operation.type == "root"}
    <div class="root dnd" use:dndzone={{items:operation.items, morphDisabled:true, flipDurationMs:250, centreDraggedOnCursor:true}} on:consider={(e)=>{consider(e, "items")}} on:finalize={(e)=>{finalize(e, "items")}}>
        {#each operation.items as op, i (op.id)}
            <!--ALWAYS WRAP CUSTOM COMPONENT IN HTML WHEN USING DNDZONE-->
            <div animate:flip={{duration: 250}}>
                <svelte:self triggerUpdate={triggerUpdate} createTask={createTask} onEdit={onEdit} operation={op} parent={operation.items} deleteOperation={deleteOperation} duplicateOperation={duplicateOperation} />
            </div>
        {/each}
    </div>
{:else if operation.type != "conditional"}
    <div class="card operation">
        {#if chaininfo && taskinfo}
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={taskinfo.icon}/>
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
            <img style="opacity: .3;" alt="task icon" class="taskicon" src={taskinfo.icon}/>
            <div>
                <p class="operationcard-label">{taskinfo.label}</p>
            </div>
        {/if}
        <div style={`position: relative; margin-left:${!chaininfo?.icon?"auto":"0"};`}>
            <CardMenu menuItems={[
                {label:"Edit", callback:()=>{onEdit(operation, parent)}, icon:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g id="pencil--change-edit-modify-pencil-write-writing"><path id="Subtract" fill="currentColor" fill-rule="evenodd" d="M8.31 22.75H1.25l0-7.06L11.94 5 19 12.06 8.31 22.75ZM20.06 11l3-3L16 .94l-3 3L20.06 11Z" clip-rule="evenodd"></path></g></svg>`}, //add pencil icon 
                {label:"Duplicate", callback:()=>{duplicateOperation(parent, operation)}, icon:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g id="copy-document"><path id="Union" fill="currentColor" fill-rule="evenodd" d="M3 1H2v19h2V3h11V1H3Zm12.25 9.5V4.75h-9.5v18h16v-11.5h-6.5v-.75Zm1.5-.75v-5h.06l4.94 4.94v.06h-5Z" clip-rule="evenodd"></path></g></svg>`}, //add copy icon
                {label:"Delete", callback:()=>{deleteOperation(parent, operation)}, icon:`<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><g id="recycle-bin-2--remove-delete-empty-bin-trash-garbage"><path id="Subtract" fill="currentColor" fill-rule="evenodd" d="M9.17 5a3.001 3.001 0 0 1 5.66 0H9.17ZM7.1 5a5.002 5.002 0 0 1 9.8 0H23v2h-2v16H3V7H1V5h6.1Zm.4 13.5v-8h2v8h-2Zm7-8v8h2v-8h-2Z" clip-rule="evenodd"></path></g></svg>`} //add trash icon
            ]}></CardMenu>
        </div>
    </div>
{:else if operation.type == "conditional"}
    <div class="card">
        <div class="conditional">
            <img style="opacity: .3;" alt="conditional operation icon" src="/task-icons/curly-brackets.svg"/>
            <p>if</p>
            <div use:dndzone={{items:operation.condition, dropFromOthersDisabled:operation.condition.length>0||operation.id=="id:dnd-shadow-placeholder-0000"?true:false, morphDisabled:true}} on:consider={(e)=>{consider(e, "condition")}} on:finalize={(e)=>{finalize(e, "condition")}} class="conditionaldnd">
                {#each operation.condition as condition(condition.id)}
                    <div animate:flip={{duration: 250}}>
                        <svelte:self triggerUpdate={triggerUpdate} createTask={createTask} operation={condition} onEdit={onEdit} parent={operation.condition} duplicateOperation={null}  deleteOperation={deleteOperation}></svelte:self>
                    </div>
                {/each}
            </div>
            <Combobox value={operation.symbol} options={conditionOptions} onChange={(newValue)=>{operation.symbol = newValue}} style="width:150px; background-color:var(--background2)"></Combobox>
            <input placeholder="Input condition here" value={operation.input} on:change={(e)=>{operation.input = e.target.value}} style="background-color:var(--background2); font-size:1rem; height:52px;"/>
            <div style="position: relative;margin-left:auto">
                <button on:click={()=>{menuopen = true;}} class="shallow color-transition"><Fa icon={faEllipsisV}></Fa></button>
                {#if menuopen}
                    <div use:clickOutside on:click_outside={()=>{menuopen = false}} transition:toprightbudino={{duration:200}} class="dialog">
                        <button on:click={()=>{duplicateOperation(parent, operation); menuopen=false;}} class="dialog-option color-transition">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="copy-document"><path id="Union" fill="var(--color)" fill-rule="evenodd" d="M3 1H2v19h2V3h11V1H3Zm12.25 9.5V4.75h-9.5v18h16v-11.5h-6.5v-0.75Zm1.5 -0.75v-5h0.06l4.94 4.94v0.06h-5Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                            Duplicate
                        </button>
                        <button on:click={()=>{deleteOperation(parent, operation)}} class="dialog-option color-transition">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="16" width="16"><g id="recycle-bin-2--remove-delete-empty-bin-trash-garbage"><path class="color-transition" id="Subtract" fill="var(--color)" fill-rule="evenodd" d="M9.17 5a3.001 3.001 0 0 1 5.66 0H9.17ZM7.1 5a5.002 5.002 0 0 1 9.8 0H23v2h-2v16H3V7H1V5h6.1Zm0.4 13.5v-8h2v8h-2Zm7 -8v8h2v-8h-2Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                            Delete
                        </button>
                    </div>
                {/if}
            </div>
        </div>
        <div class="conditional">
            <p>then</p>
            <div use:dndzone={{items:operation.then, dropFromOthersDisabled:operation.id=="id:dnd-shadow-placeholder-0000"?true:false, morphDisabled:true}} on:consider={(e)=>{consider(e, "then")}} on:finalize={(e)=>{finalize(e, "then")}} class="conditionaldnd">
                {#each operation.then as instruction(instruction.id)}
                    <div animate:flip={{duration: 250}}>
                        <svelte:self triggerUpdate={triggerUpdate} createTask={createTask} operation={instruction} onEdit={onEdit} parent={operation.then} duplicateOperation={duplicateOperation}  deleteOperation={deleteOperation}></svelte:self>
                    </div>
                {/each}
            </div>
        </div>
        <div class="conditional">
            <p>else</p>
            <div use:dndzone={{items:operation.else, dropFromOthersDisabled:operation.id=="id:dnd-shadow-placeholder-0000"?true:false, morphDisabled:true}} on:consider={(e)=>{consider(e, "else")}} on:finalize={(e)=>{finalize(e, "else")}} class="conditionaldnd">
                {#each operation.else as instruction(instruction.id)}
                    <div animate:flip={{duration: 250}}>
                        <svelte:self triggerUpdate={triggerUpdate} createTask={createTask} operation={instruction} onEdit={onEdit} parent={operation.else} duplicateOperation={duplicateOperation} deleteOperation={deleteOperation}></svelte:self>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{/if}

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
        gap: 16px;
    }
    .dialog{
        position: absolute;
        top: 0;
        right: 0;
        background: var(--background3);
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--background3);
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
        background-color: var(--color2);
        color: var(--background);
    }
    .dialog-option svg path{
        fill: var(--color2);
    }
    .dialog-option:hover svg path{
        fill: var(--background);
    }
    .params-preview{
        display: flex;
        gap: 4px 16px;
        flex-wrap: wrap;
        margin-top: 12px;
        width: 100%;
    }
    .params-preview p{
        margin: 0;
        opacity: .6;
        font-size: .8rem;
        font-weight: bold;
        max-width: 100%;
    }
    .conditionaldnd{
        min-height: 50px;
        width: fit-content;
        min-width: 200px;
        background-color: var(--background3);
    }
    .conditional{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
    }
    .conditional div{
        box-shadow: none;
    }
    .conditional p {
        margin:0;
    }
    .dnd{
        width: 100%;
        min-height: 500px;
    }
    .root{
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
</style>