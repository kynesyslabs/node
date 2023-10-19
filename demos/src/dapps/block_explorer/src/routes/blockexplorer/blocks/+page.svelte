<script>
    import '$lib/global.css';
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import CubeSpinning from '../CubeSpinning.svelte';
	import PageTitle from '../../../lib/components/PageTitle.svelte';

    demos.connect($rpcaddress);

    async function getBlocks()
    {
        let block = await demos.getBlockByNumber(0);
        let blocks = [block];
        return blocks;
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
        border-radius: var(--border-radius) var(--border-radius) 0 0;
        padding: 16px;
    }

    .card-header-label{
        margin: 0;
    }

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: var(--header-color);
        font-weight: bold;
        color: white;
        border-radius: 0 0 var(--border-radius) var(--border-radius);
    }

    .page-controller{
        display: flex;
        gap:4px;
        align-items: center;
        justify-content: right;
    }

    .page-controller-button{
        background-color: #404040;
        color: white;
        padding: 4px 8px;
        border-radius: var(--border-radius);
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
        border-bottom: 1px solid var(--border-color);
        padding: 16px;
        width: 100%;
    }

    .grid-header-row{
        background-color: var(--header-color);
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

{#await getBlocks()}
    <CubeSpinning/>
{:then blocks} 
    <PageTitle>DEMOS Blocks</PageTitle>
    <div class="card">
        <div class="card-header">   
            <p class="card-header-label">Total of 1 blocks</p>
        </div>
            <div class="transactions-grid grid-header-row">
                <p class="grid-header-label">Number</p>
                <p class="grid-header-label">Timestamp</p>
                <p class="grid-header-label">Tx</p>
                <p class="grid-header-label">Proposer</p>
            </div>
            <div class="transactions-grid">
                {#each blocks as block}
                    <a class="accessible grid-cell" href={`/blockexplorer/blocks/${block.number}`}><p class="grid-cell">{block.number}</p></a>
                    <p class="grid-cell">{block.timestamp}</p>
                    <p class="grid-cell">{block.content.ordered_transactions.length}</p>
                    <p class="grid-cell">{block.proposer}</p>
                {/each}
            </div>
            <div class="card-footer">
                <div class="page-controller">
                    <button class="page-controller-button">First</button>
                    <button class="page-controller-button"><Fa style="font-size:.8rem" icon={faChevronLeft}/></button>
                        <p class="page-controller-label">Page 1 of 1</p>
                    <button class="page-controller-button"><Fa style="font-size:.8rem" icon={faChevronRight}/></button>
                    <button class="page-controller-button">Last</button>
                </div>
            </div>
    </div>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}