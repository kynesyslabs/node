<script>
    import transIcon from '$lib/assets/icons/agreement-icon.png';
    import {timeAgo} from "$lib/env.js";
    import "$lib/styles/blockexplorer.css";
    export let transaction;
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
    }
    .loaded::after{
        content: "";
        display: block;
        position: absolute;
        top: 0;
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
            <img class="block-icon" alt="Block icon" src={transIcon}/>
        </div>
        <div style="width: 200px;">
            {#if transaction}
                <a href={`/blockexplorer/transactions/${transaction.hash}`} class="accessible loaded"><p class="block-cell" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p></a>
                <p class="loaded delayed1" style="margin: 0; color:rgb(128, 128, 128); font-size:.9rem;">{timeAgo.format(transaction.content.timestamp*1000)}</p>
            {:else}
                <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
                <div class="skeletonplaceholder delayed1" style="height:18px;"></div>
            {/if}
        </div>
    </div>
    <div>
        {#if transaction}
            <p class="loaded delayed2" style="margin-top:0;margin-bottom:8px;">From <span class="fake-link">{transaction.content.from}</span></p>
            <p class="loaded delayed3" style="margin: 0;">To <span class="fake-link">{transaction.content.to}</span></p>
        {:else}
            <div class="skeletonplaceholder delayed2" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder delayed3"></div>
        {/if}
    </div>
    <div class="reward-container generic-shadow">
        {#if transaction} 
            <p class="reward loaded delayed4" style="font-size:.8rem">{transaction.content.amount} DEM</p>
        {:else}
            <div class="skeletonplaceholder delayed4" style="height:16px;"></div>
        {/if}
    </div>
</div>