<script>
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import {timeAgo} from "$lib/env.js";
    import "$lib/styles/blockexplorer.css";
    export let block;
</script>
<style>
    .skeletonplaceholder{
        background-color: var(--background2-min);
        height: 20px;
        width: 100%;
        position: relative;
        visibility: hidden;
    }
    .skeletonplaceholder::after{
        content: "";
        display: block;
        position: absolute;
        top: 0;
        height: 100%;
        background: white;
        opacity: 1;
        animation: loadStarted cubic-bezier(0.075, 0.82, 0.165, 1) .25s forwards;
        visibility: visible;
    }
    .loaded{
        visibility: visible;
        position: relative;
        width: 100%;
    }
    .loaded::after{
        content: "";
        display: block;
        position: absolute;
        top: 0;
        right: 0;
        height: 100%;
        width: 100%;
        background: white;
        opacity: 1;
        animation: loadFinished cubic-bezier(0.075, 0.82, 0.165, 1) .25s forwards;
        visibility: visible;
    }
</style>
<div class="block-card">
    <div class="block-card-header">
        <div class="block-icon-container generic-shadow">
            <img class="block-icon" alt="Block icon" src={blockIcon}/>
        </div>
        <div style="width: 100%;">
            {#if block}
                <a class="accessible loaded" href={`/blockexplorer/blocks/${block.number}`}><p style="margin-top:0;margin-bottom:8px;">{block.number}</p></a>
                <p class="loaded delayed1" style="margin: 0; color:rgb(128,128,128); font-size:.9rem;">{timeAgo.format(block.timestamp*1000)}</p>
            {:else}
                <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
                <div class="skeletonplaceholder delayed1" style="height:18px;"></div>
            {/if}
        </div>
    </div>
    <div>
        {#if block}
            <p class="loaded delayed2" style="margin-top:0;margin-bottom:8px;">Proposer <span class="fake-link">{block.proposer}</span></p>
            <p class="loaded delayed3" style="margin: 0;font-size:.9rem;color:rgb(128,128,128);"><span>{block.content.ordered_transactions.length} transactions</span></p>
        {:else}
            <div class="skeletonplaceholder delayed2" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder delayed3" style="height:18px;"></div>
        {/if}
    </div>
    <div class="reward-container generic-shadow">
        {#if block}
            <p class="reward loaded delayed4" style="font-size:.8rem">{block.status}</p>
        {:else}
            <div class="skeletonplaceholder delayed4" style="height:16px;"></div>
        {/if}
    </div>
</div>