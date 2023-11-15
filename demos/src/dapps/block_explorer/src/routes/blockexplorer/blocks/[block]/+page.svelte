<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa'
    import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    import demos from "$lib/demos.js";
    import {rpcaddress} from "$lib/env.js";
	import CubeSpinning from '../../CubeSpinning.svelte';
    import PageTitle from '$lib/components/PageTitle.svelte';
    import CopyButton from '$lib/components/CopyButton.svelte';

    demos.connect($rpcaddress);
    async function getBlock()
    {
        if(!demos.connected)
        return;
        let block = await demos.getBlockByNumber(data.blocknumber);
        console.log(block);
        return block;
    }
</script>

{#await getBlock()}
    <CubeSpinning/>
{:then block} 
    <PageTitle>Block #{block.number}</PageTitle>
    <div class="header">
        <p style="margin:0;" class="wrapword">{block.hash}</p>
        <CopyButton text={block.hash}></CopyButton>
    </div>
    <div class="card" style="padding: 12px 0;">
        <div class="info-grid">
            <p class="info-title">Status:</p>
            <p class="info-text">{block.status}</p>
        </div>
        <div class="info-grid">
            <p class="info-title">Timestamp:</p>
            <p class="info-text">{block.content.timestamp}</p>
        </div>
            <div class="info-grid">
                <p class="info-title">Proposer:</p>
                <a href={`/blockexplorer/addresses/${block.proposer}`}>
                    <p class="info-text">{block.proposer}</p>
                </a>
            </div>
        <div class="info-grid">
            <p class="info-title">Transactions:</p>
            <p class="info-text">{block.content.ordered_transactions.length} transactions in this block</p>
        </div>
    </div>
    {#if block.content.ordered_transactions.length > 0}
    <div class="card">
        <div class="transactions-info">
            <p class="transaction-number-label">A total of {block.content.ordered_transactions.length} transactions found</p>
        </div>
        <div class="transactions-grid grid-header-row">
            <p class="grid-header-label">Hash</p>
            <p class="grid-header-label">From</p>
            <p class="grid-header-label">To</p>
            <p class="grid-header-label">Amount</p>
        </div>
        <div class="transactions-grid">
            {#each block.content.ordered_transactions as transaction}
                <a class="accessible grid-cell" href={`/blockexplorer/transactions/${transaction.hash}`}><p class="grid-cell">{transaction.hash}</p></a>
                <p class="grid-cell">{transaction.content.from}</p>
                <p class="grid-cell">{transaction.content.to}</p>
                <p class="grid-cell">{transaction.content.amount}</p>
            {/each}
        </div>
        <div class="card-footer">
            <div class="page-controller">
                <button class="page-controller-button">First</button>
                <button class="page-controller-button"><Fa style="font-size:.8rem;" icon={faChevronLeft}/></button>
                    <p class="page-controller-label">Page 1 of 1</p>
                <button class="page-controller-button"><Fa style="font-size:.8rem;" icon={faChevronRight}/></button>
                <button class="page-controller-button">Last</button>
            </div>
        </div>
    </div>
    {:else}
    <div class="card">
        <div class="transactions-info">
            <p style="margin:0; font-weight: bold;">No transactions found in this block</p>
        </div>
    </div>
    {/if}
{/await}

<style>
    .card{
        margin-bottom: 64px;
    }

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: var(--background2);
        font-weight: bold;
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
    .transactions-info{
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
    }

    .transactions-grid{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 16px;
        padding: 16px;
        width: 100%;
    }

    .transaction-number-label{
        margin: 0;
        position: relative;
        top: 4px;
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

    .info-grid{
        display: grid;
        grid-template-columns: 120px 1fr;
        width: 100%;
        gap: 0 16px;
        padding: 8px 28px;
    }
    @media screen and (max-width: 600px){
        .info-grid{
            grid-template-columns: 1fr;
        }
    }


    .info-title{
        font-weight: bold;
        margin: 0;
    }

    .info-text{
        margin: 0;
        opacity: .8;
        word-wrap: break-word;
        word-break: break-all;
    }

    .header{
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 16px;
        margin-top: -34px;
        margin-bottom: 64px;
    }
</style>