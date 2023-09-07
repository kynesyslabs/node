<script>
    import demos from '$lib/demos.js';
    import CopyButton from '$lib/components/CopyButton.svelte';
    import { saveAs } from 'file-saver';
	import Fa from 'svelte-fa';
	import { faDownload } from '@fortawesome/free-solid-svg-icons';
    let logged = demos.DemosWebAuth.getInstance().loggedIn;
    let created = false;
    async function createWallet()
    {
        created = await demos.DemosWebAuth.getInstance().create();
        console.log(created);
        logged = true;
    }

    function writeFile()
    {
        let blob = new Blob([created[1].privateKey], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "private.demos");
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
    .private-output-head{
        display: flex;
        gap: 8px;
        align-items:center;
        margin: 0 0 8px;
    }
    .status-label{
        opacity: .6;
    }
    .privateout{
        font-family: monospace;
        font-size: 1rem;
        margin: 0;
        word-break: break-all;
    }
    .or{
        margin: 0;
        opacity: .6;
        text-align: center;
    }
</style>

<h2 style="text-align: center;">Log in</h2>
<div class="card">
    {#if logged && !created}
        <p style="margin:0">You are already logged in</p>
    {:else}
        <!--<p style="margin:0"><span class="status-label">status:</span> not logged in</p>-->
        <button on:click={createWallet} class="primary">Upload your key</button>
        <p class="or">– or –</p>
        <input placeholder="Paste your key here"/>
        <div style="display: flex; align-items:center;"><span style="opacity: .6;">No wallet yet?</span>&nbsp;<a href="/createwallet">Create one</a></div>
    {/if}
</div>