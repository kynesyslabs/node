<script>
    import {scale} from "svelte/transition";
	import { cubicInOut } from "svelte/easing";
	import { onMount } from "svelte";
	import Fa from "svelte-fa";
    import { faCheck, faTimes } from "@fortawesome/free-solid-svg-icons";
    export let onClose;

    onMount(async() => {
        var top= window.scrollY;

        document.body.style.overflow= 'hidden';

        window.onscroll= function() {
            window.scroll(0, top);
        }
        let ace = await import('brace');
        await import('brace/mode/javascript');
        await import('brace/theme/tomorrow_night');
        let editor = ace.edit('code-editor');
        editor.getSession().setMode('ace/mode/javascript');
        editor.setTheme('ace/theme/tomorrow_night');
    });
</script>

<style>
    .text-editor-container{
        width: 100%;
        height: 100dvh;
        position: fixed;
        top: 0;
        left: 0;
        background-color: #101010;
        z-index: 1;
    }
    .text-editor-header{
        padding: 16px;
        background-color: var(--header-color);
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .text-editor{
        width: 100%;
        height: 100%;
        border: none;
        outline: none;
        resize: none;
        padding: 16px;
        font-size: 1rem;
    }
    .window-button{
        font-size: 1rem;
        background-color: #404040;
        color: white;
        border-radius: var(--border-radius);
        padding: 6px 12px;
        cursor: pointer;
    }
    .window-button:hover{
        background-color: var(--accent);
    }
</style>

<div transition:scale={{
    duration: 350,
    easing: cubicInOut
}} class="text-editor-container">
<div class="text-editor-header">
    <h4 style="margin:0;">Code editor for crosschain transaction</h4>
    <div>
        <button class="window-button color-transition generic-shadow" style="margin-right:8px;"><Fa icon={faCheck}></Fa></button>
        <button on:click={onClose} class="window-button color-transition generic-shadow"><Fa icon={faTimes}></Fa></button>
    </div>
</div>
<!--<textarea class="text-editor"></textarea>-->
<div class="text-editor" id="code-editor"></div>
</div>