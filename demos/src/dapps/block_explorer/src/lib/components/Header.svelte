<script>
    import '$lib/global.css';
    import {page} from '$app/stores'
	import Fa from 'svelte-fa';
	import { faBars } from '@fortawesome/free-solid-svg-icons';
	import { slide } from 'svelte/transition';
    const pages = [
        {
            label:"Block Explorer",
            href:"/blockexplorer",
            test:"blockexplorer"
        },
        {
            label:"Crosschain",
            href:"/crosschain",
            test:"crosschain"
        },
        {
            label:"Web2",
            href:"/web2/server",
            test:"web2"
        },
        {
            label:"Tx test",
            href:"/txtest",
            test:"txtest"
        }
    ]
    let mobileMenuOpen = false;
    let location;
    $:location = $page.url.pathname;
</script>

<style>
    .logo{
        width: 150px;
        margin: 24px 32px;
    }
    .header{
        background: rgba(255, 255, 255, 0.02);
        backdrop-filter: blur(15px);
        -webkit-backdrop-filter: blur(15px);
        width: 100%;
        display: flex;
        gap: 0 32px;
        height: 100%;
        position: relative;
        z-index: 500;
    }
    .link-link{
        display: flex;
        align-items: center;
    }
    .page-link{
        color: #fff;
        text-decoration: none;
        font-size: 1.1rem;
        font-weight: 600;
        cursor: pointer;
        height: 100%;
        display: flex;
        align-items: center;
    }
    .page-link-selected{
        color: var(--accent);
        text-decoration: none;
        font-size: 1.1rem;
        font-weight: 600;
        cursor: pointer;
        position: relative;
        height: 100%;
        display: flex;
        align-items: center;
    }
    .page-link-selected::after{
        content: "";
        display: block;
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 1px;
        background: var(--accent);
    }
    .menu-button{
        margin-right: 0;
        margin-left: auto;
        font-size: 1.5rem;
        padding: 0 30px;
        background: none;
        color: white;
        display: none;
    }
    .mobile-menu{
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100dvh;
        background: rgba(0, 0, 0, .9);
        backdrop-filter: blur(15px);
        z-index: 600;
        padding: 16px 32px;
    }
    .mobile-link{
        color: #fff;
        text-decoration: none;
        font-size: 2rem;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        margin: 16px 0;
        white-space: nowrap;
    }
    .mobile-link-selected{
        color: var(--accent);
        text-decoration: none;
        font-size: 2em;
        font-weight: 600;
        cursor: pointer;
        position: relative;
        display: flex;
        align-items: center;
        white-space: nowrap;
        margin: 16px 0;
    }
    .mobile-link-selected::after{
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        position: relative;
        display: flex;
        align-items: center;
    }
    @media (max-width: 768px){
        .link-link{
            display: none;
        }
        .menu-button{
            display: block;
        }
    }
    </style>

<div class="header">
    <a href="/">
        <div>
            <img alt="logo" class="logo" src="/LOGOMorph.svg"/>
        </div>
    </a>
    <button on:click={()=>{mobileMenuOpen=true}} class="menu-button"><Fa icon={faBars}></Fa></button>
    {#if mobileMenuOpen}
    <div transition:slide={{axis:"x", inverse:1}} role={"mobile menu"} on:click={()=>{mobileMenuOpen = false}} class="mobile-menu">
        {#each pages as page}
            <a on:click={(e)=>{e.stopPropagation();mobileMenuOpen = false}} href={page.href}><div class={`${location.split("/").includes(page.test)?"mobile-link-selected":"mobile-link"} color-transition`}>{page.label}</div></a>
        {/each}
    </div>
    {/if}
    {#each pages as page}
        <a class="link-link" href={page.href}><div class={`${location.split("/").includes(page.test)?"page-link-selected":"page-link"} color-transition`}>{page.label}</div></a>
    {/each}
</div>