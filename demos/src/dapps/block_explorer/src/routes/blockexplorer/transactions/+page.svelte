<script>
    import '$lib/global.css';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import CubeSpinning from "$lib/components/CubeSpinning.svelte"
	import PageTitle from '../../../lib/components/PageTitle.svelte';
	import TransactionRow from '../TransactionRow.svelte';

    demos.connect($rpcaddress);

    async function getTransactions()
    {
        if(!demos.connected)
        return;
        let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
        let transactions = [transaction];
        console.log("transactions", transactions);
        return transactions;
    }
</script>

{#await getTransactions()}
    <CubeSpinning/>
{:then transactions}
    <PageTitle>Transactions</PageTitle>
    <div class="card">
        <div class="card-header">   
            <p class="card-header-label">Total of {transactions.length} transactions</p>
        </div>
        {#each transactions as transaction}
            <TransactionRow transaction={transaction}/>        
        {/each}
        <!--<div class="card-footer">
            <div class="page-controller">
                <button class="page-controller-button" on:click={()=>{gotoPage(1)}}>First</button>
                <button class="page-controller-button" on:click={()=>{gotoPage(Math.max(thepage-1, 1))}}><Fa style="font-size:.8rem" icon={faChevronLeft}/></button>
                    <p class="page-controller-label">Page {thepage} of {Math.ceil(info.number/50)}</p>
                <button class="page-controller-button" on:click={()=>{gotoPage(Math.min(thepage+1, Math.ceil(info.number/50)))}}><Fa style="font-size:.8rem" icon={faChevronRight}/></button>
                <button class="page-controller-button" on:click={()=>{
                    gotoPage(Math.ceil(info.number/50));
                }}>Last</button>
            </div>
        </div>-->
    </div>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}

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
</style>