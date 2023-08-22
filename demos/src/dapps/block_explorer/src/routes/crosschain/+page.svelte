<script>
	import { faLongArrowRight, faPlus } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
	import TxBlock from "$lib/components/crosschain/TxBlock.svelte";
    import { v4 as uuidv4 } from "uuid";
    import { cubicInOut } from 'svelte/easing';


    let txblocks = [
        {
            id:uuidv4(),
            blockchain:"ETH",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001",
            code:`import demos from "demos";

export default function main(){
    
}`
        },
        {
            id:uuidv4(),
            blockchain:"SOL",
            operation:"Transfer",
            receivingAddress:"0x1234567890123456789012345678901234567890",
            amount:"0.0001",
            code:`import demos from "demos";

export default function main(){
    
}`
        }
    ]


    function addOperation(){
        txblocks.push({
            id:uuidv4(),
            blockchain:undefined,
            operation:undefined,
            receivingAddress:"",
            amount:"",
            code:`import demos from "demos";

export default function main(){
    
}`
        })
        txblocks = txblocks;
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
        {#each txblocks as txblock, i (txblock.id)}
            <div transition:customAnimation={{duration:350, easing:cubicInOut}}>
                <TxBlock onBlockchainSelect={(v)=>{txblocks[i].blockchain = v}} txblock={txblock} onOperationSelect={(v)=>{txblocks[i].operation = v}} index={i} onRemove={()=>{txblocks.splice(i, 1); txblocks=txblocks}}/>
            </div>
        {/each}
        <div class="action-buttons">
            <button class="secondary color-transition" on:click={()=>{addOperation()}}><Fa icon={faPlus} style="margin-right:8px;"></Fa>Add operation</button>
            <button class="primary color-transition">Execute<Fa style="margin-left:8px;" icon={faLongArrowRight}></Fa></button>
        </div>
</main>