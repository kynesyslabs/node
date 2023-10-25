<script>
	import { onMount } from "svelte";
    import ace from "ace-builds";
    import "ace-builds/src-noconflict/mode-json";
    import "ace-builds/src-noconflict/theme-tomorrow_night_eighties";
    export let text;
    export let id;

    let editor;

    onMount(async() => {
        editor = ace.edit(id);
        editor.setTheme('ace/theme/tomorrow_night_eighties');
        editor.session.setMode('ace/mode/json');
        editor.setValue(text, -1);
        editor.setReadOnly(true);
        editor.setHighlightActiveLine(false);
        editor.renderer.$cursorLayer.element.style.display = "none"
        editor.setShowPrintMargin(false);
        editor.container.style.background="transparent";

        editor.setOptions({
            maxLines: Infinity
        });

    });

    $: if(editor)editor.setValue(text, -1);
</script>

<style>
    .text-editor-container{
        border-radius: var(--border-radius);
        backdrop-filter: 14px;
    }
    .text-editor{
        width: 100%;
        height: 100%;
        border: none;
        outline: none;
        resize: none;
        font-size: 1rem;
    }
</style>

<div class="text-editor-container">
    <div class="text-editor" id={id}></div>
</div>