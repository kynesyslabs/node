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
    .card{
        max-width: 500px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 32px;
        padding: 32px;
    }
    .or{
        margin: 0;
        opacity: .6;
        text-align: center;
    }
</style>

<h2 style="text-align: center;">Log in</h2>
<div class="card">
    {#if logged}
        <p style="margin:0">Succesful login!</p>
    {:else}
        <!--<p style="margin:0"><span class="status-label">status:</span> not logged in</p>-->
        <input on:change={upload} type="file" class="custom-file-input"/>
        <p class="or">– or –</p>
        <input on:input={paste} placeholder="Paste your key here"/>
        <div style="display: flex; align-items:center;"><span style="opacity: .6;">No wallet yet?</span>&nbsp;<a href="/createwallet">Create one</a></div>
    {/if}
</div>