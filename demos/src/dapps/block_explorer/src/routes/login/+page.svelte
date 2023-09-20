<script>
    import demos from '$lib/demos.js';
    import { wallet, updateWallet } from '$lib/env.js';
    function upload(e)
    {
        const file = e.target.files[0];
        if(!file)
            return;
        const reader = new FileReader();
        reader.onload = async function(e)
        {
            console.log(e.target.result);
            await login(e.target.result);
        }
        reader.readAsText(file);
    }

    async function paste(e)
    {
        await login(e.target.value);
    }

    async function login(prvkey)
    {
        let key
        try {
            const parsed = JSON.parse(prvkey);
            const arrayed = Object.values(parsed);
            key = new Uint8Array(arrayed);
            console.log("Key passed as object")
        } catch(e) {
            key = prvkey
            console.log("Key passed as string")
        }
        const log = await demos.DemosWebAuth.getInstance().login(key);
        if(log[0])
        {
            updateWallet();
            document.cookie=`prvkey=${prvkey}`;
        }
    }
</script>

<style>
    .container{
        max-width: 532px;
        margin: auto;
    }
    .card{
        display: grid;
        grid-template-columns: 1fr;
        gap: 32px;
        padding: 64px;
        margin: 32px 0 64px;
    }
    .or{
        margin: 0;
        opacity: .2;
        text-align: center;
    }
    .nowallet
    {
        display: flex;
        align-items: center;
        justify-content: center;
    }
    @media screen and (max-width: 600px)
    {
        .card{
            padding: 32px;
            gap: 32px;
        }
    }
    .custom-file-input
    {
        max-width: 100%;
        overflow: hidden;
    }
</style>

<div class="container">
    <h2 style="text-align: center;">Connect wallet</h2>
    <div class="card">
        {#if $wallet.loggedIn}
            <p style="margin:0">Succesful login!</p>
        {:else}
            <!--<p style="margin:0"><span class="status-label">status:</span> not logged in</p>-->
            <input on:change={upload} type="file" class="custom-file-input"/>
            <p class="or">– or –</p>
            <input on:input={paste} placeholder="Paste your key here"/>
        {/if}
    </div>
    {#if !$wallet.loggedIn}
        <div class="nowallet"><span style="opacity: .6;">No wallet yet?</span>&nbsp;<a href="/createwallet">Create one</a></div>
    {/if}
</div>
