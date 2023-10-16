<script>
    import {onMount} from 'svelte';
    import demos from '$lib/demos.js';
    import {transaction} from "$lib/demos_libs/utils/skeletons.js";
    import {wallet} from '$lib/env.js';
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
        display: flex;
        align-items: center;
        margin-bottom: 64px;
        justify-content: center;
        gap: 12px;
    }
    .label{
        margin: 8px 0;
        opacity: .75;
    }
    .smallinput{
        width: 100%;
    }
    .txtest-body{
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 32px;
        width: 100%;
        max-width: 500px;
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
        margin-bottom: 64px;
    }
    @media screen and (max-width: 600px)
    {
        .card{
            padding: 24px;
        }
    }
</style>

<div>
    <div class="title">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" width="32" height="32"><g id="send-email--mail-send-email-paper-airplane"><path id="Subtract" fill="#ffffff" fill-rule="evenodd" d="m23.223.777-7.91 22.597-4.813-4.813-4.25 4.25v-7.25l8.719-6.975-.938-1.172-8.154 6.524L.626 8.686 23.223.777Z" clip-rule="evenodd"></path></g></svg>
        <h2 style="position:relative;top:4px;">Raw transaction</h2>
    </div>
    <form on:submit={sendTransaction} class="card txtest-body">
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
        <button class="primary" type="submit" style="width: 100%;">Send</button>
    </form>
</div>