<script>
    import '$lib/global.css';
	import TransactionGrid from '../TransactionGrid.svelte';
    import demos from '$lib/demos.js';
    import {rpcaddress} from '$lib/env.js';
    import CubeSpinning from '../CubeSpinning.svelte';
	import PageTitle from '../../../lib/components/PageTitle.svelte';

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

{#await getTransactions()}
    <CubeSpinning/>
{:then transactions}
    <PageTitle>Transactions</PageTitle>
    <TransactionGrid transactions={transactions}/>
{:catch}
    <p style="text-align: center;">Something went wrong</p>
{/await}