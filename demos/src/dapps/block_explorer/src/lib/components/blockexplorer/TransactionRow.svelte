<script>
    import transIcon from '$lib/assets/icons/agreement-icon.png';
    import {timeAgo} from "$lib/env.js";
    import "$lib/styles/blockexplorer.css";
    export let transaction;
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
            <img class="block-icon" alt="Block icon" src={transIcon}/>
        </div>
        <div style="width: 200px;">
            {#if transaction}
                <a href={`/blockexplorer/transactions/${transaction.hash}`} class="accessible"><p class="block-cell" style="margin-top:0;margin-bottom:8px;">{transaction.hash}</p></a>
                <p style="margin: 0; opacity:.5; font-size:.9rem;">{timeAgo.format(transaction.content.timestamp*1000)}</p>
            {:else}
                <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
                <div class="skeletonplaceholder" style="height:14.4px;"></div>
            {/if}
        </div>
    </div>
    <div>
        {#if transaction}
            <p style="margin-top:0;margin-bottom:8px;">From <span class="fake-link">{transaction.content.from}</span></p>
            <p style="margin: 0;">To <span class="fake-link">{transaction.content.to}</span></p>
        {:else}
            <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder"></div>
        {/if}
    </div>
    <div class="reward-container generic-shadow">
        {#if transaction} 
            <p class="reward" style="font-size:.8rem">{transaction.content.amount} DEM</p>
        {:else}
            <div class="skeletonplaceholder" style="height:12.8px;"></div>
        {/if}
    </div>
</div>