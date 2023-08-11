<script>
    import Fa from 'svelte-fa';
    import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
</script>

<style>
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
        top: 24px;
    }
    .inputContainer{
        width: 500px;
        max-width: calc(100% - 32px);
        margin: 32px auto;
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
    }
    .subtitle{
        text-align: center;
        margin-top: 0;
        font-family: 'Neue Machina', sans-serif;
    }
</style>

<div style="background:url('/poster.jpg');background-position:center;background-size:cover">
    <a href="/"><img alt="logo" class="logo" src="/logo.jpg"/></a>
    <h1>Demos</h1>
    <h2 class="subtitle">Block explorer</h2>
    <div class="inputComponent">
        <p class="label">Search by hash</p>
        <div class="inputContainer">
            <input class="inputElement" placeholder=""/>
            <button class="inputButton"><Fa icon={faMagnifyingGlass}></Fa></button>
        </div>
    </div>
</div>