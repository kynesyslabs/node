<script>
	import { onMount } from "svelte";
    export let text;
    export let id;

    onMount(async() => {
        let ace = await import('brace');
        await import('brace/mode/javascript');
        await import('brace/theme/tomorrow_night');
        let editor = ace.edit(id);
        editor.getSession().setMode('ace/mode/javascript');
        editor.setTheme('ace/theme/tomorrow_night');
        editor.setValue(text, -1);

        editor.setOptions({
            maxLines: Infinity
        });
    });
</script>

<style>
    .text-editor{
        width: 100%;
        border: none;
        outline: none;
        resize: none;
        font-size: 1rem;
    }
</style>

<div class="text-editor" id={id}></div>