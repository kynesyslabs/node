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
        overflow: hidden;
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
<div style="padding:0 24px; max-width:1440px;margin:auto;width:100%;">
    <Header/>
    <main>
        <PageTitle>Raw Transaction</PageTitle>
        <div class="login-alert">
            <img alt="wallet icon" class="login-icon" src="/task-icons/wallet.svg"/>
            <p>You need to connect your wallet to send a raw transaction</p>
        </div>
    </main>
    <Footer/>
</div>
{/if}