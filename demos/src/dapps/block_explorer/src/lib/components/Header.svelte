<script>
    import {page} from '$app/stores'
	import Fa from 'svelte-fa';
	import { faBars } from '@fortawesome/free-solid-svg-icons';
	import { slide } from 'svelte/transition';
    import {wallet} from '$lib/env.js';
    import demos from '$lib/demos.js';
    import { goto } from '$app/navigation';
    import { updateWallet } from '$lib/env.js';
    const pages = [
        {
            label:"EXPLORER",
            href:"/blockexplorer",
            test:"blockexplorer"
        },
        {
            label:"xM",
            href:"/crosschain",
            test:"crosschain"
        },
        {
            label:"WEB2",
            href:"/web2",
            test:"web2"
        },
        {
            label:"TX",
            href:"/txtest",
            test:"txtest"
        }
    ]
    async function logOut()
    {
        document.cookie="prvkey=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;"
        await demos.DemosWebAuth.getInstance().logout();
        updateWallet();
        localStorage.removeItem("prvkey");
        goto("/login");
    }
    let mobileMenuOpen = false;
    let location;
    $:location = $page.url.pathname;
</script>

<style>
    .logo{
        width: 120px;
        margin: 24px 0px;
    }
    .header{
        max-width: 1440px;
        margin: 16px auto;
        width: calc(100% - 48px);
        display: flex;
        gap: 0 32px;
        position: relative;
        z-index: 500;
        align-items: center;
        justify-content: space-between;
    }
    .onlydesktop{
        display: flex;
        align-items: center;
    }
    .desktoplinks{
        display: grid;
        grid-auto-columns: 1fr;
        grid-auto-flow: column;
    }
    .desktoplink{
        width: fit-content;
        margin: auto;
    }
    .desktoplinkcontainer{
        padding: 0 32px;
    }
    .desktoplinkcontainer:not(:last-child){
        border-right: 1px solid var(--background2);
    }
    .page-link{
        color: var(--color);
        text-decoration: none;
        font-size: 1rem;
        font-weight: 100;
        cursor: pointer;
        height: 100%;
        display: flex;
        align-items: center;
        position: relative;
    }
    .page-link-selected{
        color: var(--color2);
        text-decoration: none;
        font-size: 1rem;
        font-weight: 400;
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
        background: var(--color2);
    }
    .page-link::after{
        content: "";
        display: block;
        position: absolute;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 1px;
        background: var(--color2);
        transform: scaleX(0);
        transition: transform .3s ease;
        transform-origin: left;
    }
    .page-link:hover::after{
        transform: scaleX(1);
    }
    .menu-button{
        margin-right: 0;
        margin-left: auto;
        background: none;
        color: var(--color);
        display: none;
    }
    .mobile-menu{
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100dvh;
        background: var(--background);
        z-index: 600;
        padding: 16px 32px;
    }
    .mobile-link{
        color: var(--color);
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
        color: var(--color2);
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
        color: var(--color2);
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        position: relative;
        display: flex;
        align-items: center;
    }
    .login-button{
        align-self: center;
        padding: 8px 16px;
        margin-left: auto;
    }
    @media (max-width: 800px){
        .onlydesktop{
            display: none;
        }
        .menu-button{
            display: block;
        }
    }
    </style>

<div class="header" style={`z-index:${mobileMenuOpen?"2000":"500"};`}>
    <a href="/blockexplorer" style="flex-basis:100%;">
        <div>
            <img alt="logo" class="logo darkinvert" src="/logo/Logo DEMOS White.svg"/>
        </div>
    </a>
    <button on:click={()=>{mobileMenuOpen=true}} class="menu-button"><Fa icon={faBars} style="font-size:1.5rem"></Fa></button>
    {#if mobileMenuOpen}
    <div transition:slide={{axis:"x", inverse:1}} role={"mobile menu"} on:click={()=>{mobileMenuOpen = false}} class="mobile-menu">
        {#each pages as page}
            <a class="nounderline" on:click={(e)=>{e.stopPropagation();mobileMenuOpen = false}} href={page.href}><div class={`${location.split("/").includes(page.test)?"mobile-link-selected":"mobile-link"} color-transition`}>{page.label}</div></a>
        {/each}
        {#if $wallet.loggedIn}
        <a style="text-decoration: none;"><button class="secondary mobile-link" on:click={logOut}>Log Out</button></a>
        {:else}
        <a href="/login"><button class="mobile-link primary" style="color:var(--background);">Connect Wallet</button></a>
        {/if}
    </div>
    {/if}
    <div class="desktoplinks onlydesktop" style="flex-basis:100%;">
    {#each pages as page}
        <div class="desktoplinkcontainer">
            <div class="desktoplink">
                <a class="nounderline " href={page.href}><div class={`${location.split("/").includes(page.test)?"page-link-selected":"page-link"} color-transition`}>{page.label}</div></a>
            </div>
        </div>
    {/each}
    </div>
    {#if $wallet.loggedIn}
        <div class="onlydesktop" style="flex-basis:100%;">
            <button class="login-button secondary " on:click={logOut}>Log Out</button>
        </div>
    {:else if location != "/login"}
        <a href="/login" class="onlydesktop" style="flex-basis:100%;"><button class="primary login-button">Connect Wallet</button></a>
    {:else}
        <div class="onlydesktop" style="flex-basis: 100%;"> </div>
    {/if}
</div>