<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte"; 
	import { fly } from "svelte/transition";
    export let data;
    import {wallet} from '$lib/env.js';
    import PageTitle from "$lib/components/PageTitle.svelte";
</script>

<style>
    main{
        margin: 64px 0;
        flex: 1;
    }
    .content-container{
        max-width: 1440px;
        margin: auto;
        width: calc(100% - 48px);
    }
    @media screen and (max-width: 600px)
    {
        main{
            margin: 16px 0;
        }
    }
</style>

{#if $wallet.loggedIn}
<div class="master-container">
<Header />
    <main>
        {#key data.url}
                <div class="content-container" in:fly={{ x: 200, duration: 300, delay: 300 }} out:fly={{ x: -200, duration: 300 }}>
                    <slot/>
                </div>
        {/key}
    </main>
    <Footer/>
</div>
{:else}
<div style="max-width:1440px;margin:auto;width:100%;">
    <Header/>
    <main class="content-container">
        <PageTitle>Web2 Request</PageTitle>
        <div class="login-alert">
            <img alt="wallet icon" class="login-icon" src="/task-icons/wallet.svg"/>
            <p>You need to connect your wallet to make a web2 request</p>
        </div>
    </main>
    <Footer/>
</div>
{/if}

