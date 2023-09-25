<script>
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";
    import {dndzone, SHADOW_ITEM_MARKER_PROPERTY_NAME} from "svelte-dnd-action";
	import OperationCard from "$lib/components/crosschain/OperationCard.svelte";
    import {flip} from "svelte/animate";
    import {operationsdata} from "$lib/env.js";

    localStorage.clear("operations");

    //nussun piano di salvataggio
    //$operationsdata = localStorage.getItem("operationsdata")?JSON.parse(localStorage.getItem("operationsdata")):{};
    //tutto qui
    let root = {id:"root", items:[], type:"root"}

    //prima abbiamo usato l'index, poi abbiamo usato l'id... adesso passiamo direttamente la reference
    let edit = null;
    
    function onUpdate(operation, data)
    {
        operation.data = data;
        root = root
    }

    function deleteOperation(parentArray, operation)
    {
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index, 1);
        parentArray = parentArray;
    }

    
    //$:console.log(operations);
    //$:localStorage.setItem("operations", JSON.stringify(operations));
    function transformDraggedElement(draggedEl, data, index)
    {
        draggedEl.innerHTML = data.label;
    }
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

{#if edit !== null}
    <OperationEditor onSave={(data)=>{onUpdate(edit, data); edit = null;}} operation={edit} onClose={()=>{edit = null}} onDelete={(parentArray)=>{deleteOperation(parentArray, edit); edit=null}}/>
{/if}
<div>
    <div class="title-container">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="35" width="35"><g id="sign-hashtag--mail-sharp-sign-hashtag-tag"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M8.27 0.776 7.275 6.25H3v2.5h3.82l-1.181 6.5H1v2.5h4.184l-0.914 5.026 2.46 0.448 0.995 -5.474 6.46 0 -0.915 5.026 2.46 0.448 0.995 -5.474H21v-2.5h-3.82l1.181 -6.5H23v-2.5h-4.184l0.914 -5.026 -2.46 -0.448 -0.995 5.474H9.816l0.914 -5.026L8.27 0.776Zm6.37 14.474 1.181 -6.5h-6.46l-1.181 6.5 6.459 0Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
        <h3 class="title">Crosschain transaction editor</h3>
    </div>
    <div>
        <div class="card dnd">
            <OperationCard onEdit={(op)=>{edit = op}} operation={root}/>
        </div>
    </div>
</div>
