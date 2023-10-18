<script>
    import '$lib/global.css';
	import TransactionGrid from '../TransactionGrid.svelte';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import CubeSpinning from '$lib/components/blockexplorer/CubeSpinning.svelte';

    demos.connect($rpcaddress);

    async function getTransactions()
    {
        if(!demos.connected)
        return;
        let transaction = await demos.getTxByHash("dd3fc542784875538efef89815672c693f8175f1007450b8e890c618650dd03e");
        let transactions = [transaction];
        return transactions;
    }
</script>

<style>
    .title{
        text-align: center;
        margin-bottom: 64px;
    }
</style>

{#await getTransactions()}
    <CubeSpinning/>
{:then transactions}
    <h2 class="title">Transactions</h2>
    <TransactionGrid transactions={transactions}/>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}