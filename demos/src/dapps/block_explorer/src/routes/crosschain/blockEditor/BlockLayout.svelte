<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte"; 
	import OperationBar from "./OperationBar.svelte";
    import {wallet} from '$lib/env.js';
    import PageTitle from "$lib/components/PageTitle.svelte";
</script>

<style>
    .thegrid{
        display: grid;
        grid-template-columns: auto 1fr;
    }

    main{
        margin: 64px 0;
        flex: 1;
        overflow: hidden;
    }
    @media screen and (max-width: 600px)
    {
        main{
            margin: 16px 0;
        }
    }
</style>

{#if $wallet.loggedIn}
<div class="thegrid">
    <OperationBar/>
    <div style="max-width:1440px;margin:auto;width:100%;">
        <Header />
        <main style="padding:0 24px; ">
            <slot/>
        </main>
        <Footer/>
    </div>
</div>
{:else}
<div style="max-width:1440px;margin:auto;width:100%;">
    <Header/>
    <main style="padding:0 24px; ">
        <PageTitle>Cross-Chain Transaction</PageTitle>
        <div class="login-alert">
            <img alt="wallet icon" class="login-icon" src="/task-icons/wallet.svg"/>
            <p>You need to connect your wallet to create a crosschain transaction</p>
        </div>
    </main>
    <Footer/>
</div>
{/if}