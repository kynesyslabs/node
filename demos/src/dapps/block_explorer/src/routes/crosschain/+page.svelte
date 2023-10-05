<script>
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";
	import OperationCard from "$lib/components/crosschain/OperationCard.svelte";
    import XMTransactions from "$lib/demos_libs/XMTransactions.js";
    import demos from "$lib/demos.js"
    import { rpcaddress }  from '$lib/env.js';

    localStorage.clear("operations");

    //nussun piano di salvataggio
    //$operationsdata = localStorage.getItem("operationsdata")?JSON.parse(localStorage.getItem("operationsdata")):{};
    //tutto qui
    let root = {id:"root", items:[], type:"root"}

    //prima abbiamo usato l'index, poi abbiamo usato l'id... adesso passiamo direttamente la reference
    let edit = null;
    let editparent = null;
    
    function onUpdate(operation, data)
    {
        operation.data = data;
        root = root
    }

    function deleteOperation(parentArray, operation)
    {
        let index = parentArray.findIndex(op=>op.id == operation.id);
        parentArray.splice(index, 1);
        root = root;
    }

    const conditionOptions = [
        {id:"equals", label:"=="},
        {id:"greater", label:">"},
        {id:"less", label:"<"},
        {id:"greaterorequals", label:">="},
        {id:"lessorequals", label:"<="},
        {id:"notequals", label:"!="},
    ]

    //crea JSON da root
    async function createJSON()
    {
        XMTransactions.operation.clear();
        for(const op of root.items)
        {
            const pushOp = (op)=>{
                XMTransactions.operation.create(op.id, op.data.chain, op.data.subchain, op.data.is_evm, op.data.rpc, op.data.task, op.data.conditional)
            }
            if(op.type=="conditional")
            {
                XMTransactions.operation.create_condition(op.id, "if", `${op.condition[0].id} ${conditionOptions.find(s=>s.id == op.symbol).label} ${op.input}`, op.then.map(op=>op.id), op.else.map(op=>op.id));
                if(!op.condition[0])
                    return;
                pushOp(op.condition[0]);
                op.then.forEach(op=>pushOp(op));
                op.else.forEach(op=>pushOp(op));
            }
            else
            {
                pushOp(op);
            }
        }
    }

    async function execute()
    {
        demos.connect(rpcaddress);
        createJSON();
        let result = await demos.crosschain.execute(XMTransactions.operation.get())
        console.log(result);
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
    .dnd{
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-rows: 1fr;
        gap: 16px;
        padding: 24px;
    }
    .executebtn{
        margin-left: auto;
        margin-top: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
</style>

{#if edit !== null}
    <OperationEditor onSave={(data)=>{onUpdate(edit, data); edit = null; editparent=null;}} operation={edit} onClose={()=>{edit = null; editparent = null;}} onDelete={()=>{deleteOperation(editparent, edit); edit=null; editparent=null;}}/>
{/if}
<div>
    <div class="title-container">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="35" width="35"><g id="sign-hashtag--mail-sharp-sign-hashtag-tag"><path id="Union" fill="#ffffff" fill-rule="evenodd" d="M8.27 0.776 7.275 6.25H3v2.5h3.82l-1.181 6.5H1v2.5h4.184l-0.914 5.026 2.46 0.448 0.995 -5.474 6.46 0 -0.915 5.026 2.46 0.448 0.995 -5.474H21v-2.5h-3.82l1.181 -6.5H23v-2.5h-4.184l0.914 -5.026 -2.46 -0.448 -0.995 5.474H9.816l0.914 -5.026L8.27 0.776Zm6.37 14.474 1.181 -6.5h-6.46l-1.181 6.5 6.459 0Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
        <h3 class="title">Crosschain transaction editor</h3>
    </div>
    <div>
        <div class="card dnd">
            <OperationCard onEdit={(op, parent)=>{edit = op; editparent=parent;}} operation={root} deleteOperation={deleteOperation}/>
        </div>
    </div>
    <button on:click={execute} class="executebtn primary">Execute
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" height="24" width="24"><g id="end-point-arrow"><path id="Union" fill="#000000" fill-rule="evenodd" d="m14.472 17.92 -1.819 1.212 0.692 -2.073L14.697 13H1v-2h13.698l-1.353 -4.059 -0.692 -2.073 1.82 1.212 7.943 5.296 0.936 0.624 -0.936 0.624 -7.944 5.296Z" clip-rule="evenodd" stroke-width="1"></path></g></svg>
    </button>
</div>
