<script>
	import { faLongArrowRight, faPlus } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { v4 as uuidv4 } from "uuid";
    import { cubicInOut } from 'svelte/easing';
	import OperationEditor from "$lib/components/crosschain/OperationEditor.svelte";

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
        margin: 0 auto;
    }
    
</style>

<main>
    {#each operations as txblock, i (txblock.id)}
        <div transition:customAnimation={{duration:350, easing:cubicInOut}}>
            <OperationEditor txblock={txblock.data} index={i} onRemove={()=>{operations.splice(i, 1); operations=operations}}/>
        </div>
    {/each}
    <div class="action-buttons">
        <button class="secondary color-transition" on:click={()=>{addOperation()}}><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</button>
        <button class="primary color-transition">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></button>
    </div>
</main>