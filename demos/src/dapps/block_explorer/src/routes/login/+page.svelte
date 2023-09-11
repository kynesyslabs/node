<script>
    import demos from '$lib/demos.js';
    let logged = demos.DemosWebAuth.getInstance().loggedIn;
    function upload(e)
    {
        const file = e.target.files[0];
        if(!file)
            return;
        const reader = new FileReader();
        reader.onload = async function(e)
        {
            const parsed = JSON.parse(e.target.result);
            const arrayed = Object.values(parsed);
            const key = new Uint8Array(arrayed);
            const log = await demos.DemosWebAuth.getInstance().login(key);
            logged = log[0];
        }
        reader.readAsText(file);
    }

    async function paste(e)
    {
        console.log(e)
        const parsed = JSON.parse(e.target.value);
        const arrayed = Object.values(parsed);
        const key = new Uint8Array(arrayed);
        const log = await demos.DemosWebAuth.getInstance().login(key);
        logged = log[0];
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
        {#if logged}
            <p style="margin:0">Succesful login!</p>
        {:else}
            <!--<p style="margin:0"><span class="status-label">status:</span> not logged in</p>-->
            <input on:change={upload} type="file" class="custom-file-input"/>
            <p class="or">– or –</p>
            <input on:input={paste} placeholder="Paste your key here"/>
        {/if}
    </div>
    {#if !logged}
        <div class="nowallet"><span style="opacity: .6;">No wallet yet?</span>&nbsp;<a href="/createwallet">Create one</a></div>
    {/if}
</div>
