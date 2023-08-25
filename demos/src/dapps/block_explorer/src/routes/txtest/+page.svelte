<script>
    import {onMount} from 'svelte';
    import demos from '$lib/demos.js';
    import forge from 'node-forge';
    export let data;
    const ed25519 = forge.pki.ed25519;
    const keypair = ed25519.generateKeyPair();
    //console.log(data.skeleton);
    onMount(async()=>{
        let txdata = data.skeleton;
        txdata.content.timestamp = new Date();
        let txprep = await demos.transactions.prepare(txdata);
        let txsigned = await demos.transactions.sign(txprep, keypair.privateKey);
        let txsent = await demos.transactions.broadcast(txsigned);
        console.log(txsent);
    })
</script>

<style>
    .container{
        padding: 16px;
    }
</style>

<div class="container">
    <div class="card">
        {#each Object.keys(data.skeleton.content) as key}
            <p>{key}</p>
            <input/>
        {/each}
    </div>
</div>
