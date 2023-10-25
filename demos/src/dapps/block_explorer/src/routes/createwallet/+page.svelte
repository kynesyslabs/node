<script>
    import demos from '$lib/demos.js';
    import CopyButton from '$lib/components/CopyButton.svelte';
    import { saveAs } from 'file-saver';
	import Fa from 'svelte-fa';
	import { faDownload } from '@fortawesome/free-solid-svg-icons';
    import {updateWallet} from '$lib/env.js';
    import PageTitle from '$lib/components/PageTitle.svelte';
    let logged = demos.DemosWebAuth.getInstance().loggedIn;
    let created = false;
    if(!logged)
        createWallet();
    async function createWallet()
    {
        created = await demos.DemosWebAuth.getInstance().create();
        updateWallet(); 
        logged = true;
    }

    function writeFile()
    {
        let blob = new Blob([created[1].privateKey], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "private.demos");
    }
</script>

<style>
    .private-output-head{
        display: flex;
        gap: 8px;
        align-items:center;
        margin: 0 0 8px;
    }
    .privateout{
        font-family: monospace;
        font-size: 1rem;
        margin: 0;
        word-break: break-all;
    }
</style>

{#if created}
<PageTitle>Wallet Created!</PageTitle>
<div class="private-output-head">
    <p style="margin:0">This is the key for your brand new wallet!</p>
    <CopyButton text={created[1].privateKey}/>
    <button on:click={writeFile} class="small-button tooltip color-transition"><span class="tooltiptext">Download</span><Fa icon={faDownload}/></button>
</div>
<p style="opacity: .6;">Do not lose or share with anyone</p>
<div class="card2" style="padding:32px">
    <p class="privateout">{created[1].privateKey}</p>
</div>
{:else if logged}
<h2>You are already logged in!</h2>
{/if}
