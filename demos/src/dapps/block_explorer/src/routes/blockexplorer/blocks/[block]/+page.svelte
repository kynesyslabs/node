<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa'
    import { faArrowLeftLong, faArrowRightLong, faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    import blockIcon from '$lib/assets/icons/cube-icon.png';
    import demos from "$lib/demos.js";
    import {rpcaddress} from "$lib/env.js";
	import CubeSpinning from '$lib/components/blockexplorer/CubeSpinning.svelte';

    demos.connect(rpcaddress);
    async function getBlock()
    {
        if(!demos.connected)
        return;
        let block = await demos.getBlockByNumber(data.blocknumber);
        return block;
    }
</script>

<style>
    .block-icon{
        filter: invert();
        width: 55px;
    }
    .card{
        margin-bottom: 64px;
    }


    .card-header{
        display: flex;
        align-items: center;
        gap: 32px;
        justify-content: center;
        margin: 0 0 64px;
    }

    .block-header{
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .adjacent-button{
        padding: 8px;
        cursor: pointer;
        width: 37px;
        height: 37px;
        display: flex;
        justify-content: center;
        position: relative;
    }
    

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: var(--background2-min);
        font-weight: bold;
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
        border-bottom: 1px solid var(--border-color);
    }

    .transactions-grid{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 16px;
        border-bottom: 1px solid var(--border-color);
        padding: 16px;
        width: 100%;
    }

    .transaction-number-label{
        margin: 0;
        position: relative;
        top: 4px;
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

    .info-grid{
        display: grid;
        grid-template-columns: 100px 1fr;
        width: 100%;
        gap: 16px;
        padding: 28px;
    }

    .info-title{
        font-weight: bold;
        margin: 0;
    }

    .info-text{
        margin: 0;
        opacity: .8;
    }

    .info{
        word-wrap: break-word;
        word-break: break-all;
        display: flex;
        align-items: center;
        gap: 8px;
    }
</style>

{#await getBlock()}
    <CubeSpinning/>
{:then block} 
    <div class="card-header">
        <button class="secondary adjacent-button">
            <Fa style="position:relative;top:1px;" icon={faArrowLeftLong}></Fa>
        </button>
        <div class="block-header">
            <img class="block-icon" alt="Block icon" src={blockIcon}/>
            <h3 style="margin:0">Block #{block.number}</h3>
        </div>
        <button class="secondary adjacent-button">
            <Fa style="position:relative;top:1px;" icon={faArrowRightLong}></Fa>
        </button>        
    </div>

    <div class="card">
        <div class="info-grid">
            <p class="info-title">Status:</p>
            <p class="info-text">{block.status}</p>
            <p class="info-title">Timestamp:</p>
            <p class="info-text">{block.timestamp}</p>
            <p class="info-title">Proposer:</p>
            <p class="info-text">{block.proposer}</p>
            <p class="info-title">Transactions:</p>
            <p class="info-text">{block.content.ordered_transactions.length} transactions in this block</p>
        </div>
    </div>
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
{/await}