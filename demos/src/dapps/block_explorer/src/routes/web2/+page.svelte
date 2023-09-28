<script>
    import demos from '$lib/demos.js';
	import { faGlobe } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";
    import { rpcaddress } from '$lib/env.js';

    export let data;
    let output = data.data;

    const rpc = rpcaddress;

    demos.connect(rpc);
    async function makeRequest(ev)
    {
        ev.preventDefault();
        let url = ev.target[0].value;
        let data = await demos.getWeb2Data(url);
        output = data.data;
    }
</script>

<style>
    .info-grid{
        display: grid;
        grid-template-columns: 150px 1fr;
        width: 100%;
        gap: 8px;
    }

    .info-grid:not(:last-child){
        margin-bottom: 32px;

    }

    @media screen and (max-width: 600px)
    {
        .info-grid{
            grid-template-columns: 1fr;
        }
    }

    .info-title{
        font-weight: bold;
        margin: 0;
    }

    .block-icon-container{
        width:55px;
        height: 45px;
        border-radius: var(--border-radius);
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .card-header{
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .block-header{
        display: flex;
        align-items: center;
        width: 100%;
        margin-bottom: 64px;
        justify-content: center;
    }
    .url-input{
        margin-bottom: 16px;
        width: 100%;
        max-width: 500px;
    }
    .request-button{
        width: 100%;
        max-width: 500px;
    }
    .card{
        margin-bottom: 64px;
        padding: 32px;
    }
    @media screen and (max-width: 600px)
    {
        .card{
            padding: 24px;
        }
    }
</style>

<div class="card-header">
    <div class="block-header">
        <div class="block-icon-container generic-shadow">
            <Fa style="font-size:2rem" icon={faGlobe}></Fa>
        </div>
        <h3 class="ellipsis" style="margin: 0;">Web2 request</h3>
    </div>      
</div>

<form on:submit={makeRequest} style="width: 100%; max-width:500px" class="card">    
    <p class="label">URL</p>
    <input placeholder="https://apple.com/robots.txt" class="url-input"/>
    <button class="primary request-button">Make request</button>
</form>

<div class="card">
    {#each Object.keys(output) as key}
        <div class="info-grid">
            <p class="info-title">{key}:</p>
            {#if typeof output[key] === "object"}
                <p class="wrapword" style="margin:0;">{JSON.stringify(output[key])}</p>
            {:else}
                <p class="wrapword" style="margin:0;">{output[key]}</p>
            {/if}
        </div>
    {/each}
</div>    
