<script>
    import {onMount} from 'svelte';
    import demos from '$lib/demos.js';
    import forge from 'node-forge';
    export let data;
    const ed25519 = forge.pki.ed25519;
    const keypair = ed25519.generateKeyPair();
    //console.log(data.skeleton);
    onMount(async()=>{
        /*let txprep = await demos.transactions.prepare(txdata);
        let txsigned = await demos.transactions.sign(txprep, keypair.privateKey);
        let txsent = await demos.transactions.broadcast(txsigned);
        console.log(txsent);*/
    })
    async function sendTransaction(ev){
        ev.preventDefault();
        let txdata = data.skeleton;
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
        let txsigned = await demos.transactions.sign(txprep, keypair.privateKey);
        console.log("broadcasting transaction");
        let txsent = await demos.transactions.broadcast(txsigned);
        console.log(txsent);
    }
</script>

<style>
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
