<script>
    import '$lib/global.css';
    export let data;
	import CopyButton from '$lib/components/CopyButton.svelte';
    import demos from "$lib/demos.js";
    import {rpcaddress} from "$lib/env.js";
    import CubeSpinning from "$lib/components/CubeSpinning.svelte"
	import PageTitle from '$lib/components/PageTitle.svelte';

    demos.connect($rpcaddress);

    async function getTransaction()
    {
        if(!demos.connected)
        return;
        let transaction = await demos.getTxByHash(data.transaction);
        transaction = JSON.parse(transaction);
        return transaction;
    }
</script>

{#await getTransaction()}
    <CubeSpinning/>
{:then transaction}
    <PageTitle>Transaction Details</PageTitle>
    <div class="header">
        <p style="margin:0;" class="wrapword">{transaction.hash}</p>
        <CopyButton text={transaction.hash}></CopyButton>
    </div>
    <div class="card" style="padding: 12px 0;">
        <div class="info-grid">
            <p class="info-title">Type:</p>
            <div class="info"><p class="info-text">{transaction.content.type}</p></div>
        </div>
        <div class="info-grid">
            <p class="info-title">Currency:</p>
            <div class="info"><p class="info-text">{transaction.content.data.properties.name} ({transaction.content.data.properties.currency})</p></div>
        </div>
        <div class="info-grid">
            <p class="info-title">From:</p>
            <div class="info"><p class="info-text">{transaction.content.from}</p><CopyButton text={transaction.content.from}></CopyButton></div>
        </div>
        <div class="info-grid">
            <p class="info-title">To:</p>
            <div class="info"><p class="info-text">{transaction.content.to}</p><CopyButton text={transaction.content.to}></CopyButton></div>
        </div>
        <div class="info-grid">
            <p class="info-title">Amount:</p>
            <div class="info"><p class="info-text">{transaction.content.amount}</p></div>
        </div>
    </div>
{/await}

<style>
    .card{
        margin-bottom: 64px;
    }

    .info{
        word-wrap: break-word;
        word-break: break-all;
        display: flex;
        align-items: center;
        gap: 8px;
    }


    .info-grid{
        display: grid;
        grid-template-columns: 120px 1fr;
        width: 100%;
        gap: 0 16px;
        padding: 16px 28px;
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
