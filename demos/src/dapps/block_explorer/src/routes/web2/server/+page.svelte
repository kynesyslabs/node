<script>
    import demos from '$lib/demos.js';
	import { faGlobe } from "@fortawesome/free-solid-svg-icons";
	import Fa from "svelte-fa";

    export let data;
    const rpc = "http://85.208.48.187:53550";

    demos.connect(rpc);
    async function makeRequest(ev)
    {
        ev.preventDefault();
        let url = ev.target[0].value;
        let data = await demos.getWeb2Data(url);
        console.log(data);
    }
</script>

<style>
    .container{
        padding: 16px;
    }
    .info-grid{
        display: grid;
        grid-template-columns: 150px 1fr;
        width: 100%;
        gap: 16px;
        padding: 16px;
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
        margin-bottom: 28px;
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
</style>

<div class="container">
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

        {#each Object.keys(data.data) as key}
            <div class="info-grid">
                <p style="margin:0;">{key}</p>
                {#if typeof data.data[key] === "object"}
                    <p class="wrapword" style="margin:0;">{JSON.stringify(data.data[key])}</p>
                {:else}
                    <p class="wrapword" style="margin:0;">{data.data[key]}</p>
                {/if}
            </div>
        {/each}
    </div>    
</div>
