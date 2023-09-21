<script>
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";
    import {dndzone} from "svelte-dnd-action";
	import OperationCard from "$lib/components/crosschain/OperationCard.svelte";
    import {flip} from "svelte/animate";
	import ConditionalCard from "$lib/components/crosschain/ConditionalCard.svelte";
    import {Operation} from "$lib/chainscript.js";

    //i dati devono esistere su due piani differenti:
    //1. il piano di salvataggio
    //2. il piano di visualizzazione

    //nel piano di salvataggio (1.) i dati sono organizzati sullo stesso livello
    //in questo modo è molto facile accedere ai dati e modificarli
    //su questo piano l'ordine dei dati non è importante
    //la struttura dei dati è la seguente:
    //{id: Operation||Conditional, ...}
    //tutto è contenuto in un array per facilitare l'accesso ai dati anche iterativamente

    //nel piano di visualizzazione (2.) i dati sono nestati
    //in questo piano i dati sono salvati come reference al piano di salvataggio
    //questi dati sono usati direttamente per la creazione dell'area di drag and drop
    //la struttura dei dati è la seguente:
    //[{id: id, children: [{id: id, children: [...]}, {...}]

    localStorage.clear("operations");

    //piano di salvataggio
    let operationsdata = localStorage.getItem("operationsdata")?JSON.parse(localStorage.getItem("operationsdata")):{};
    //piano di visualizzazione
    let operations = localStorage.getItem("operations")?JSON.parse(localStorage.getItem("operations")):[];

    let editID = null;
    
    function onUpdate(id, data)
    {
        operationsdata[id] = data;
        console.log(operationsdata[id] = data)
    }

    function deleteOperation(id)
    {
        let index = operations.findIndex(op=>op.id == id);
        operations.splice(index, 1);
        operations = operations;
        delete operationsdata[id];
        operationsdata = operationsdata;
    }

    function handleDndConsider(e) {
        operations = e.detail.items;
    }
    function handleDndFinalize(e) {
        operations = e.detail.items;
        //let newItemIndex = operations.findIndex(op=>op.id == e.detail.info.id);
        //anziché trovare l'index semplicemente uso l'id
        let operationdata = operationsdata[e.detail.info.id];
        /*if(operationdata.constructor == Operation)
        {
            let chainflag = (operationdata.chain == "crosschain" && operationdata.subchain) || (operationdata.chain !== "crosschain" && operationdata.chain);
            let taskflag = true;
            for(let i = 0; i < Object.values(operationdata.task.params).length; i++)
            {
                if(Object.values(operationdata.task.params)[i] == "" || !Object.values(operationdata.task.params)[i])
                {
                    taskflag = false;
                    break;
                }
            }
            if(!chainflag || !taskflag)
                editID = e.detail.info.id;
        }*/
        //anziché verificare il costruttore semplicemente verifico che esista
        if(operationdata)
            return;
        editID = e.detail.info.id;
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
    .no-operations{
        text-align: center;
        margin: 0 auto;
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
    .dnd{
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-rows: 1fr;
        gap: 16px;
        padding: 24px;
    }
</style>

{#if editID !== null}
    <OperationEditor onSave={(data)=>{onUpdate(editID, data); editID = null;}} operation={operations.find(op=>op.id===editID)} operationdata={operationsdata[editID]} onClose={()=>{editID = null}} onDelete={()=>{deleteOperation(editID); editID=null}}/>
{/if}
    <div>
        <div class="title-container">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="35" width="35"><g id="sign-hashtag--mail-sharp-sign-hashtag-tag"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M8.27 0.776 7.275 6.25H3v2.5h3.82l-1.181 6.5H1v2.5h4.184l-0.914 5.026 2.46 0.448 0.995 -5.474 6.46 0 -0.915 5.026 2.46 0.448 0.995 -5.474H21v-2.5h-3.82l1.181 -6.5H23v-2.5h-4.184l0.914 -5.026 -2.46 -0.448 -0.995 5.474H9.816l0.914 -5.026L8.27 0.776Zm6.37 14.474 1.181 -6.5h-6.46l-1.181 6.5 6.459 0Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
            <h3 class="title">Crosschain transaction editor</h3>
        </div>
        <div>
            <div class="card dnd" use:dndzone={{items:operations, morphDisabled:true, flipDurationMs:250, centreDraggedOnCursor:true}} on:consider={handleDndConsider} on:finalize={handleDndFinalize}>
                {#if operations.length < 1}
                    <div class="no-operations">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="128" width="128"><g id="script-1--language-programming-code"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M18 1H4v14.5h11v5h-1.5V17H1v6h17V4h1.5v5H23V1h-5ZM7 7.75h8v-1.5H7v1.5Zm8 4.5H7v-1.5h8v1.5Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
                        <p>No operation created yet</p>
                    </div>
                {:else}
                    {#each operations as operation, i (operation.id)}
                        <!--ALWAYS WRAP CUSTOM COMPONENT IN HTML WHEN USING DNDZONE-->
                        <div animate:flip={{duration: 250}}>
                            {#if !operationsdata[operation.id]}
                                <div></div>
                            {:else if operation.type != "conditional"}
                                <OperationCard deleteOperation={()=>{deleteOperation(i)}} onEdit={()=>{editID = operation.id}} operationdata={operationsdata[operation.id]}/>
                            {:else}
                                <ConditionalCard/>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        </div>
    </div>
