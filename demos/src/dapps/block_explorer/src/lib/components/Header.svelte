<script>
    import '$lib/global.css';
    import {page} from '$app/stores'
	import Fa from 'svelte-fa';
	import { faBars } from '@fortawesome/free-solid-svg-icons';
    const pages = [
        {
            label:"Block Explorer",
            href:"/"
        },
        {
            label:"Crosschain",
            href:"/crosschain"
        },
        {
            label:"Web2",
            href:"/web2/server"
        },
        {
            label:"Tx test",
            href:"/txtest"
        }
    ]
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
        width: 100%;
        display: flex;
        gap: 0 32px;
        height: 100%;
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
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(15px);
        z-index: 100;
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
    <button class="menu-button"><Fa icon={faBars}></Fa></button>
    <!--<div class="mobile-menu">
        {#each pages as page}
            <a class="link-link" href={page.href}><div class={location == page.href?"page-link-selected color-transition":"page-link"}>{page.label}</div></a>
        {/each}
    </div>-->
    {#each pages as page}
        <a class="link-link" href={page.href}><div class={location == page.href?"page-link-selected color-transition":"page-link"}>{page.label}</div></a>
    {/each}
</div>