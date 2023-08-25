<script>
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
    export let transactions;
</script>

<style>
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
        grid-template-columns: 1fr 1fr 1fr 1fr 1fr 1fr;
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

<div class="grid-card">
    <div class="card-header">   
        <p class="card-header-label">Total of 1 transactions</p>
    </div>
        <div class="transactions-grid grid-header-row">
            <p class="grid-header-label">Hash</p>
            <p class="grid-header-label">Type</p>
            <p class="grid-header-label">Currency</p>
            <p class="grid-header-label">From</p>
            <p class="grid-header-label">To</p>
            <p class="grid-header-label">Amount</p>
        </div>
        <div class="transactions-grid">
            {#each transactions as transaction}
                <a class="accessible grid-cell" href={`/blockexplorer/blocks/${transaction.hash}`}><p class="grid-cell">{transaction.hash}</p></a>
                <p class="grid-cell">{transaction.content.type}</p>
                <p class="grid-cell">{transaction.content.data.properties.name} ({transaction.content.data.properties.currency})</p>
                <p class="grid-cell">{transaction.content.from}</p>
                <p class="grid-cell">{transaction.content.to}</p>
                <p class="grid-cell">{transaction.content.amount}</p>
            {/each}
        </div>
        <div class="card-footer">
            <div class="page-controller">
                <button class="page-controller-button">First</button>
                <button class="page-controller-button"><Fa icon={faChevronLeft}/></button>
                    <p class="page-controller-label">Page 1 of 1</p>
                <button class="page-controller-button"><Fa icon={faChevronRight}/></button>
                <button class="page-controller-button">Last</button>
            </div>
        </div>
</div>