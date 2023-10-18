<script>
    import {rpcaddress} from "$lib/env.js";
	import RPCselection from "$lib/components/inputs/RPCselection.svelte";
    const links = [
        {
            label: "DOCS",
            url: "https://uploads-ssl.webflow.com/637666f7c0a45f6ef07fab12/64b5bebfccca8da619a1ea72_DEMOS%20Yellow%20Paper.pdf"
        },
        {
            label:"TWITTER",
            url:"https://twitter.com/KynesysLabs"
        }
    ]

    import "$lib/assets/backgrounds/bubblesbg.jpeg";

    let selectrpc = false;
</script>
<style>
    .footer{
        max-width: 1440px;
        margin: 16px auto;
        width: calc(100% - 48px);
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 64px;
        gap: 0 32px;
        border-top: 1px solid var(--background3);
        padding-top: 16px;
    }
    .footer-links{
        display: flex;
        gap: 16px;
    }
    .footer-link{
        color:white;
        font-weight: bold;
    }
    .companyname{
        font-weight: bold;
        font-size: 1.2rem;
        font-family: 'Helvetica Neue';
    }
    .background-blur{
        position: fixed;
        backdrop-filter: blur(100px);
        height: 100dvh;
        width: 100dvw;
        z-index: -1;
        bottom: 0;
    }
    .background{
        position: absolute;
        background: url("/backgrounds/bubblesbg.jpg") center center;
        background-size: cover;
        height: 100dvh;
        width: 100%;
        z-index: -2;
        bottom: 0;
    }
    .arrow{
        transform: rotate(181deg);
    }
</style>


<!--<div class="background-blur">
</div>

<div class="background">
</div>-->
<div class="footer">
    <svg class="arrow" width="45" height="45" viewBox="0 0 45 45" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.08294 3.61158L7.72346 3.915L6.67399 33.1931L39.7929 0.0741859L44.9254 5.20667L11.8065 38.3256L41.0846 37.2761L41.388 43.9167L0.79083 44.5107L0.488918 44.2088L1.08294 3.61158Z" fill="var(--background3)"/>
    </svg>
    <div class="footer-links">
        {#each links as link}
            <a class="footer-link" href={link.url}>{link.label}</a>
        {/each}
    </div>
    <p>Node address: <span on:click={()=>{selectrpc = true}} style="text-decoration: underline; cursor:pointer">{$rpcaddress}</span></p>
    {#if selectrpc}
    <RPCselection close={()=>{selectrpc = false}}/>
    {/if}
    <p>All rights reserved</p>
</div>