<script>
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import {timeAgo} from "$lib/env.js";
    import "$lib/styles/blockexplorer.css";
	import { onMount } from 'svelte';
    import {normalize_timestamp} from "$lib/env.js";
    export let block;
    export let missing;
    console.log(missing);
    let address_section_width = 0;
    onMount(() => {
        address_section_width = document.getElementById("address_section").offsetWidth;
    });
    function onResize() {
        address_section_width = document.getElementById("address_section").offsetWidth;
    }
    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        if(address_section_width < 300)
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
        if(address_section_width >= 300 && address_section_width < 500)
        return str.substr(0, 20) + '...' + str.substr(str.length-4, str.length);
        if(address_section_width >= 500 && address_section_width < 700)
        return str.substr(0, 30) + '...' + str.substr(str.length-4, str.length);
        if(address_section_width >= 700 && address_section_width < 900)
        return str.substr(0, 40) + '...' + str.substr(str.length-4, str.length);
        return str;
    }

</script>
<svelte:window on:resize={onResize}/>
{#if !missing}
<div class="block-card">
    <div class="block-card-header">
        {#if block}
            <div class="number-section">
                <img class="block-icon" alt="Block icon" src={blockIcon}/>
                <a class="accessible loaded" href={`/blockexplorer/blocks/${block.number}`}><p class="block-number">Block #{block.number}</p></a>
            </div>
            <p class="loaded delayed1" style="margin: 0; color:rgb(128,128,128); font-size:.9rem;">{timeAgo.format(normalize_timestamp(block.content.timestamp))}</p>
        {:else}
            <div class="skeletonplaceholder" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder delayed1" style="height:18px;"></div>
        {/if}
    </div>
    <div id="address_section">
        {#if block}
            <p class="loaded delayed2" style="margin-top:0;margin-bottom:8px;">{trim_address(block.hash, address_section_width)}</p>
            <p class="loaded delayed3" style="margin: 0;font-size:.9rem;color:rgb(128,128,128);"><span>{block.content.ordered_transactions.length} transactions</span></p>
        {:else}
            <div class="skeletonplaceholder delayed2" style="margin-bottom:8px"></div>
            <div class="skeletonplaceholder delayed3" style="height:18px;"></div>
        {/if}
    </div>
    <div class="reward-container">
        {#if block}
            <p class="reward loaded delayed4" style="font-size:.8rem">{block.status}</p>
        {:else}
            <div class="skeletonplaceholder delayed4" style="height:16px;"></div>
        {/if}
    </div>
</div>
{:else}
<div class="block-card">
    MISSING BLOCK
</div>
{/if}

<style>
    .block-card{
        display: grid;
        grid-template-columns: 150px 1fr 100px;
        gap: 16px;
        padding: 24px;
        align-items: center;
    }
    @media only screen and (max-width:650px) {
        .block-card{
            grid-template-columns: 1fr;
        }
    }
    .block-card:nth-child(even){
        background-color: var(--background2);
    }


    .block-card-header{
        flex-direction: column;
        align-items: start;
        gap: 0;
    }
    .number-section{
        display: flex;
        align-items: center;
        margin-bottom: 8px;
        gap: 0 8px;
    }
    .block-icon{
        width: 16px;
        height: 16px;
    }
    .block-number{
        margin: 0;
    }

    .skeletonplaceholder{
        background-color: var(--background3);
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
        background: var(--background3);
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
        background: var(--background3);
        opacity: 1;
        animation: loadFinished cubic-bezier(0.075, 0.82, 0.165, 1) .25s forwards;
        visibility: visible;
    }
</style>