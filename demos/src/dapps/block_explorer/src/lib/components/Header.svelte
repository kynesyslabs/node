<script>
    import Fa from 'svelte-fa';
    import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
    import video from "$lib/assets/videos/morph-bg.mp4";
    import { goto } from '$app/navigation';

    function onSearch(hash)
    {
        goto(`/blocks/${hash}`);
    }
</script>

<style>
    .container{
        position: relative;
        background-color: black;
        min-height: 25dvh;
    }
    .header-body{
        position: relative;
    }
    .logo{
        border-radius: 50%;
        width: 100px;
        margin: 16px;
    }
    .label{
        margin-bottom: 8px;
        opacity: .75;
        text-align: center;
        font-size: 1rem;

    }
    .inputComponent{
        position: relative;
        top: 20px;
        margin: 32px 0;
    }
    .inputContainer{
        width: 500px;
        max-width: calc(100% - 32px);
        margin: 0 auto 32px;
        background-color: #404040;
        display: flex;
        border-radius: var(--border-radius);
    }
    .inputElement{
        width: calc(100% - 50px);
        border-radius: var(--border-radius) 0 0 var(--border-radius);
    }
    .inputButton{
        background-color: var(--accent);
        border: none;
        color: white;
        border-radius: 0 var(--border-radius) var(--border-radius) 0;
        width: 50px;
        font-size: 20px;
        cursor: pointer;
    }
    .subtitle{
        text-align: center;
        margin-top: 0;
        font-family: 'Neue Machina', sans-serif;
    }
    .video{
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        z-index: 0;
    }
</style>

<div class="container">
    <video class="video" autoplay muted loop>
        <source src={video} type="video/mp4"/>
    </video>
    <div class="header-body">
        <a href="/"><img alt="logo" class="logo" src="/logo.jpg"/></a>
        <h1>Demos</h1>
        <h2 class="subtitle">Block explorer</h2>
        <div class="inputComponent">
            <p class="label">Search by hash</p>
            <form on:submit={(e)=>{e.preventDefault();onSearch(e.target.elements.hash.value)}} class="inputContainer">
                <input class="inputElement" name="hash" placeholder=""/>
                <button type="submit" class="inputButton"><Fa style="cursor:pointer;" icon={faMagnifyingGlass}></Fa></button>
            </form>
        </div>
    </div>
</div>