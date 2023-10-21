<script>
    import {rpcaddress} from "$lib/env.js";
	import RPCselection from "$lib/components/inputs/RPCselection.svelte";
    const links = [
        {
            label: "DOCS",
            url: "https://uploads-ssl.webflow.com/637666f7c0a45f6ef07fab12/64b5bebfccca8da619a1ea72_DEMOS%20Yellow%20Paper.pdf"
        },
        {
            label:"X",
            url:"https://twitter.com/KynesysLabs"
        }
    ]

    import "$lib/assets/backgrounds/bubblesbg.jpeg";

    let selectrpc = false;
</script>
<style>
    .footer{
        max-width: 1440px;
        margin: 0 auto;
        width: calc(100% - 48px);
        display: grid;
        align-items: center;
        grid-template-columns: 1fr 1fr 1fr;
        margin-top: 64px;
        border-top: 1px solid var(--background3);
        padding: 40px 0;
    }
    @media screen and (max-width: 768px){
        .footer{
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 16px;
        }
    }
    .footer-links{
        display: flex;
        gap: 16px;
        justify-content: center;
    }
    .footer-link-container{
        color:white;
        font-weight: 100;
        padding: 0 32px;
    }
    .arrow{
        transform: rotate(181deg);
    }
    .node-selection{
        margin-left: auto;
        font-weight: 100;
        width: fit-content;
        opacity: .6;
    }
    .node-selection-header{
        display: flex;
        justify-content: space-between;
        gap: 8px;
    }
    .change-node{
        margin-left: auto;
        font-weight: 100;
        text-decoration: underline;
    }

    .footer-link{
        color: #fff;
        text-decoration: none;
        font-size: 1rem;
        font-weight: 100;
        cursor: pointer;
        height: 100%;
        display: flex;
        align-items: center;
        position: relative;
    }
    .footer-link::after{
        content: "";
        display: block;
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 1px;
        background: var(--accent);
        transform: scaleX(0);
        transition: transform .3s ease;
        transform-origin: left;
    }
    .footer-link:hover::after{
        transform: scaleX(1);
    }
    .footer-link-container:not(:last-child){
        border-right: 1px solid var(--background2-min);
    }
</style>

<div class="footer">
    <svg class="arrow" width="45" height="45" viewBox="0 0 45 45" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1.08294 3.61158L7.72346 3.915L6.67399 33.1931L39.7929 0.0741859L44.9254 5.20667L11.8065 38.3256L41.0846 37.2761L41.388 43.9167L0.79083 44.5107L0.488918 44.2088L1.08294 3.61158Z" fill="var(--background3)"/>
    </svg>
    <div class="footer-links">
        {#each links as link}
            <div class="footer-link-container">
                <a class="footer-link" href={link.url}>{link.label}</a>
            </div>
        {/each}
    </div>
    <div class="node-selection">
        <div class="node-selection-header">
            <p style="margin:0; font-weight:600;">Connected node</p>
            <button class="change-node" on:click={()=>{selectrpc = true}}>[change]</button>
        </div>
        <p style="margin:0;">{$rpcaddress}</p>
    </div>
    {#if selectrpc}
    <RPCselection close={()=>{selectrpc = false}}/>
    {/if}
</div>