<script>
    import '$lib/global.css';
    export let data;
    import Fa from 'svelte-fa';
    import {faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
</script>

<style>
    main{
        padding: 16px;
    }
    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
        background-color: #252525;
        border-bottom: 0;
    }

    .card-header-label{
        margin: 0;
    }

    .card-footer{
        padding: 16px;
        text-align: center;
        background-color: #252525;
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
        background-color: #252525;
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

<main>
    <div class="card generic-shadow">
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
                <!--{#each data.block.content.transactions as transaction}-->
                    <a class="accessible grid-cell" href={`/blocks/${data.transaction.hash}`}><p class="grid-cell">{data.transaction.hash}</p></a>
                    <p class="grid-cell">{data.transaction.content.content.type}</p>
                    <p class="grid-cell">{data.transaction.content.content.data.properties.name} ({data.transaction.content.content.data.properties.currency})</p>
                    <p class="grid-cell">{data.transaction.content.content.from}</p>
                    <p class="grid-cell">{data.transaction.content.content.to}</p>
                    <p class="grid-cell">{data.transaction.content.content.amount}</p>
                <!--{/each}-->
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
    </main>