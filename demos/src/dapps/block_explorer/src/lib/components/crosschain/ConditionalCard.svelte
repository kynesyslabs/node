<script>
    import {dndzone} from "svelte-dnd-action";
	import OperationCard from "./OperationCard.svelte";
	import { flip } from "svelte/animate";
    let conditions = [];

    function handleDndConsider(e) {
        conditions = e.detail.items;
    }
    function handleDndFinalize(e) {
        conditions = e.detail.items;
    }
</script>
<style>
    .card{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
        background-color: var(--background2-min);
        border: 1px solid var(--background3);
    }
    .card p{
        margin: 0;
    }
    .dnd{
        gap: 16px;
        height: 50px;
        width: 100%;
        background-color: var(--background3);
    }
</style>
<div class="card" use:dndzone={{items:conditions, dropFromOthersDisabled:conditions.length>0?true:false}} on:consider={handleDndConsider} on:finalize={handleDndFinalize}>
    <img style="opacity: .3;" alt="conditional operation icon" src="/task-icons/curly-brackets.svg"/>
    <p>if</p>
    <div class="dnd">
        {#each conditions as condition(condition.id)}
            <div animate:flip={{duration: 250}}>
                <OperationCard  operation={condition}/>
            </div>
        {/each}
    </div>
</div>