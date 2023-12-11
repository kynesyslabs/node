<script>
    import { theme, updateTheme, selectedEditor, updateSelectedEditor} from "$lib/env.js";
	import RPCselection from "./RPCselection.svelte";
    import PageTitle from "$lib/components/PageTitle.svelte";
</script>

<PageTitle>Settings</PageTitle>
<div class="card">
    <RPCselection/>
    <hr style="margin: 32px 0;">
    <!--theme selection-->
    <div>
        <h4>Theme</h4>
        <!--tab buttons-->
        <div class="tab-container">
            <button on:click={()=>{updateTheme("auto")}} class={`tab ${$theme=="auto"?"selected":""}`}>
                Auto
            </button>
            <button on:click={()=>{updateTheme("light")}} class={`tab ${$theme=="light"?"selected":""}`}>
                Light
            </button>
            <button on:click={()=>{updateTheme("dark")}} class={`tab ${$theme=="dark"?"selected":""}`}>
                Dark
            </button>
        </div>
    </div>
    <hr style="margin: 32px 0;">
    <div style="margin-bottom: 16px;">
        <h4>xM Editor</h4>
        <!--tab buttons-->
        <div class="tab-container">
            <button on:click={()=>{updateSelectedEditor("auto")}} class={`tab ${$selectedEditor=="auto"?"selected":""}`}>
                Auto
            </button>
            <button on:click={()=>{updateSelectedEditor("block")}} class={`tab ${$selectedEditor=="block"?"selected":""}`}>
                Block Editor
            </button>
            <button on:click={()=>{updateSelectedEditor("flow")}} class={`tab ${$selectedEditor=="flow"?"selected":""}`}>
                Flow Editor BETA
            </button>
        </div>
    </div>
</div>

<style>
    hr{
        margin: 0;
        border: none;
        border-bottom: 1px solid var(--background3);
    }
    h4{
        font-weight: bold;
    }
    .card{
        padding: 24px;
    }
    .tab-container{
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 16px;
    }
    .tab{
        padding: 8px 16px;
        cursor: pointer;
        transition: background-color .2s ease-in-out, color .2s ease-in-out;
    }
    .tab:hover{
        background-color: var(--color);
        color: var(--background);
    }
    .tab.selected{
        background-color: var(--color);
        color: var(--background);
    }
</style>