<script>
    import '$lib/global.css';
    import '$lib/styles/typography.css';
    import '$lib/styles/input.css';
    import '$lib/styles/buttons.css';
    import '$lib/styles/surfaces.css';
    import demos from "$lib/demos.js"
    import {updateWallet, updateRpcAddress, updateTheme} from "$lib/env.js";

    let logcheck = false;
    
    async function login(prvkey)
    { 
        let key
        try {
            const parsed = JSON.parse(prvkey);
            const arrayed = Object.values(parsed);
            key = new Uint8Array(arrayed);
        } catch(e) {
            key = prvkey
        }
        const log = await demos.DemosWebAuth.getInstance().login(key);
        if(log[0])
        {
            updateWallet();
            localStorage.setItem("prvkey", prvkey);
        }
    }
    
    onMount(async ()=>{
        const selectedrpc = localStorage.getItem("selectedrpc");
        if(selectedrpc)
        {
            updateRpcAddress(selectedrpc);
        }
        const storedkey = localStorage.getItem("prvkey");
        if(storedkey)
        {
            await login(storedkey);
        }
        logcheck = true;
        let savedtheme = localStorage.getItem("theme");
        if(savedtheme)
        {
            updateTheme(savedtheme);
        }
    })

    import "nprogress/nprogress.css";
    import NProgress from "nprogress";
      import { navigating } from "$app/stores";
	import { onMount } from 'svelte';

    NProgress.configure({
        // Full list: https://github.com/rstacruz/nprogress#configuration
        minimum: 0.16,
    });

    $: {
        if ($navigating) {
            NProgress.start();
        } else NProgress.done();
    }
</script>

<style>
    .loading{
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
    }
    .lds-ripple {
        display: inline-block;
        position: relative;
        width: 80px;
        height: 80px;
    }
    .lds-ripple div {
        position: absolute;
        border: 4px solid var(color);
        opacity: 1;
        border-radius: 50%;
        animation: lds-ripple 1s cubic-bezier(0, 0.2, 0.8, 1) infinite;
    }
    .lds-ripple div:nth-child(2) {
        animation-delay: -0.5s;
    }
    @keyframes lds-ripple {
        0% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 0;
        }
        4.9% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 0;
        }
        5% {
            top: 36px;
            left: 36px;
            width: 0;
            height: 0;
            opacity: 1;
        }
        100% {
            top: 0px;
            left: 0px;
            width: 72px;
            height: 72px;
            opacity: 0;
        }
    }
</style>
{#if logcheck}
    <slot/>
{:else}
    <div class="loading">
        <div class="lds-ripple"><div></div><div></div></div> 
    </div>
{/if}


