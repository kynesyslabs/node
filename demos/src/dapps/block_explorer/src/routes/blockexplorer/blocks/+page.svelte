<script>
    import '$lib/global.css';
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import CubeSpinning from '../CubeSpinning.svelte';
	import PageTitle from '../../../lib/components/PageTitle.svelte';
    import { page } from '$app/stores';
    import { goto } from "$app/navigation";
	import BlockRow from '../BlockRow.svelte';
 
    const url = $page.url;
    let thepage = url.searchParams.get('page')?parseInt(url.searchParams.get('page')):1;

    demos.connect($rpcaddress);


    async function getBlocks(page)
    {
        let blockRequests = [];
        let blockNumber = JSON.parse(await demos.getLastBlockNumber());
        for(let i = blockNumber - ((page-1)*50); i > Math.max(blockNumber - ((page-1)*50) -50, 7); i--)
        {   
            blockRequests.push(demos.getBlockByNumber(i));
        }
        let blocks = await Promise.all(blockRequests);
        return {number:blockNumber, blocks:blocks};
    }

    function gotoPage(pagenumber)
    {
        const newUrl = new URL($page.url);
        newUrl?.searchParams?.set('page', pagenumber);
        window.location.replace(newUrl);
    }
</script>

<style>
    .title{
        text-align: center;
        margin-bottom: 64px;
    }
    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        border-bottom: 0;
        padding: 16px;
    }

    .card-header-label{
        margin: 0;
    }

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: var(--background2);
        font-weight: bold;
        color: var(--color);
    }

    .page-controller{
        display: flex;
        gap:4px;
        align-items: center;
        justify-content: right;
    }

    .page-controller-button{
        background-color: var(--background3);
        color: var(--color);
        padding: 4px 8px;
        box-shadow: rgba(17, 17, 26, 0.05) 0px 4px 16px, rgba(17, 17, 26, 0.05) 0px 8px 32px;
    }
    .page-controller-label{
        margin:0;
        font-size: .8rem;
        position: relative;
        margin-top: 4px;
    }

    .transactions-grid{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 16px;
        padding: 16px;
        width: 100%;
    }

    .grid-header-row{
        background-color: var(--background2);
    }

    .grid-header-label{
        font-weight: bold;
        margin:0;
    }

    .grid-cell{
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin: 0;
    }
</style>

{#await getBlocks(thepage)}
    <CubeSpinning/>
{:then info} 
    <PageTitle>DEMOS Blocks</PageTitle>
    <div class="card">
        <div class="card-header">   
            <p class="card-header-label">Total of {info.number} blocks</p>
        </div>
            <!--<div class="transactions-grid grid-header-row">
                <p class="grid-header-label">Number</p>
                <p class="grid-header-label">Timestamp</p>
                <p class="grid-header-label">Tx</p>
                <p class="grid-header-label">Proposer</p>
            </div>-->
            {#each info.blocks as block}
            <!--<a class="accessible grid-cell" href={`/blockexplorer/blocks/${block.number}`}><p class="grid-cell">{block.number}</p></a>
            <p class="grid-cell">{block.content.timestamp}</p>
            <p class="grid-cell">{block.content.ordered_transactions.length}</p>
            <p class="grid-cell">{block.proposer}</p>-->
            <BlockRow block={block}/>
            {/each}
            {#if thepage == Math.ceil(info.number/50)}
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            <BlockRow missing></BlockRow>
            {/if}
            <div class="card-footer">
                <div class="page-controller">
                    <button class="page-controller-button" on:click={()=>{gotoPage(1)}}>First</button>
                    <button class="page-controller-button" on:click={()=>{gotoPage(Math.max(thepage-1, 1))}}><Fa style="font-size:.8rem" icon={faChevronLeft}/></button>
                        <p class="page-controller-label">Page {thepage} of {Math.ceil(info.number/50)}</p>
                    <button class="page-controller-button" on:click={()=>{gotoPage(Math.min(thepage+1, Math.ceil(info.number/50)))}}><Fa style="font-size:.8rem" icon={faChevronRight}/></button>
                    <button class="page-controller-button" on:click={()=>{
                        gotoPage(Math.ceil(info.number/50));
                    }}>Last</button>
                </div>
            </div>
    </div>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}