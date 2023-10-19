<script>
    import Header from "$lib/components/Header.svelte";
    import Footer from "$lib/components/Footer.svelte"; 
	import OperationBar from "./OperationBar.svelte";
    import {wallet} from '$lib/env.js';
</script>

<style>
    .thegrid{
        display: grid;
        grid-template-columns: auto 1fr;
    }
    .alert-container{
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 50dvh;
        flex-direction: column;
        gap: 32px;
    }
    .alert-icon{
        width: 64px;
        height: 64px;
        display: block;
        opacity: .3;
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
    <div style="padding:0 24px; max-width:1440px;margin:auto;width:100%;">
        <Header />
        <main>
            <slot/>
        </main>
        <Footer/>
    </div>
</div>
{:else}
<Header/>
<div class="alert-container">
<img alt="wallet icon" class="alert-icon" src="/task-icons/wallet.svg"/>
<p>You need to connect your wallet to create a crosschain transaction</p>
</div>
{/if}