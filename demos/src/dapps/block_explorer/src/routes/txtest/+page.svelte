<script>
    import demos from '$lib/demos.js';
    import {transaction} from "$lib/demos_libs/utils/skeletons.js";
    import {wallet} from '$lib/env.js';
    import PageTitle from '$lib/components/PageTitle.svelte';
    async function sendTransaction(ev){
        ev.preventDefault();
        let txdata = transaction;
        txdata.content.type = ev.target[0].value;
        txdata.content.from = ev.target[1].value;
        txdata.content.to = ev.target[2].value;
        txdata.content.amount = ev.target[3].value;
        txdata.content.data = [ev.target[4].value, ev.target[5].value];
        txdata.content.timestamp = null;
        console.log(txdata);
        console.log("preparing transaction");
        let txprep = await demos.transactions.prepare();
        console.log("signing transaction");
        let txsigned = await demos.transactions.sign(txprep, $wallet.keypair.privateKey);
        console.log("broadcasting transaction");
        let txsent = await demos.transactions.broadcast(txsigned);
        console.log(txsent);
    }
</script>

<style>
    .title{
        margin: 0;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
    }
    .smallinput{
        width: 100%;
    }
    .txtest-body{
        display: grid;
        grid-template-columns: 1fr 1fr;
        align-items: end;
        gap: 32px;
        margin-bottom: 24px;
    }
    @media screen and (max-width: 650px) {
        .txtest-body {
            grid-template-columns: 1fr;
        }
    }
    .multiple-input{
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
    }
    .input-block{
        width: 100%;
    }
    .card{
        padding: 32px;
        margin-bottom: 24px;
        max-width: 1050px;
    }
    @media screen and (max-width: 600px)
    {
        .card{
            padding: 24px;
        }
    }
</style>

<div>
    <PageTitle>Raw transaction</PageTitle>
    <form on:submit={sendTransaction} class="card">
        <div class="txtest-body">
            <div class="input-block">
                <p class="label">Type</p>
                <input class="smallinput"/>
            </div>
            <div class="input-block">
                <p class="label">From</p>
                <input class="smallinput"/>
            </div>
            <div class="input-block">
                <p class="label">To</p>
                <input class="smallinput"/>
            </div>
            <div class="input-block">
                <p class="label">Amount</p>
                <input class="smallinput"/>
            </div>
            <div class="input-block">
                <p class="label">Data</p>
                <div class="multiple-input">
                    <input class="smallinput"/>
                    <input class="smallinput"/>
                </div>
            </div>
        </div>
        <button class="primary" type="submit" style="width: 100%; max-width:1050px;margin:auto;">
            Send
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="16" height="16"><g id="send-email--mail-send-email-paper-airplane"><path id="Subtract" fill="#000000" fill-rule="evenodd" d="m23.223.777-7.91 22.597-4.813-4.813-4.25 4.25v-7.25l8.719-6.975-.938-1.172-8.154 6.524L.626 8.686 23.223.777Z" clip-rule="evenodd"></path></g></svg>
        </button>
    </form>
</div>