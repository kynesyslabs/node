<script>
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import {timeAgo} from "$lib/env.js";
    import "$lib/styles/blockexplorer.css";
    export let block;
</script>
<style>
    .skeletonplaceholder{
        background-color: var(--background2-min);
        height: 16px;
        width: 100%;
    }
</style>
<div class="block-card">
    <div class="block-card-header">
        <div class="block-icon-container generic-shadow">
            <img class="block-icon" alt="Block icon" src={blockIcon}/>
        </div>
        <div>
            {#if block}
                <a class="accessible" href={`/blockexplorer/blocks/${block.number}`}><p style="margin-top:0;margin-bottom:8px;">{block.number}</p></a>
                <p style="margin: 0; opacity:.5; font-size:.9rem;">{timeAgo.format(block.timestamp*1000)}</p>
            {:else}
                <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
                <div class="skeletonplaceholder" style="height:14.4px;"></div>
            {/if}
        </div>
    </div>
    <div>
        {#if block}
            <p style="margin-top:0;margin-bottom:8px;">Proposer <span class="fake-link">{block.proposer}</span></p>
            <p style="margin: 0;font-size:.9rem;opacity:.5;"><span>{block.content.ordered_transactions.length} transactions</span></p>
        {:else}
            <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder" style="height:14.4px;"></div>
        {/if}
    </div>
    <div class="reward-container generic-shadow">
        {#if block}
            <p class="reward" style="font-size:.8rem">{block.status}</p>
        {:else}
            <div class="skeletonplaceholder" style="height:12.8px;"></div>
        {/if}
    </div>
</div>