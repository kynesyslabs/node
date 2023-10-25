<script>
    import ace from "ace-builds";
    import "ace-builds/src-noconflict/mode-json";
    import "ace-builds/src-noconflict/theme-tomorrow_night_eighties";
	import { onMount } from "svelte";
    export let text;
    export let id;
    export let onChange;

    let editor;
    let errors = [];

    onMount(async() => {
        editor = ace.edit(id);
        editor.setTheme('ace/theme/tomorrow_night_eighties');
        editor.session.setMode('ace/mode/json');
        editor.setValue(text, -1);
        editor.container.style.background="transparent";
        editor.on("change", ()=>{
            onChange(editor.getValue());
        });
        /*editor.getSession().on("changeAnnotation", function () {
            var annot = editor.getSession().getAnnotations();
            errors = [];
            for (var key in annot) {
                if (annot.hasOwnProperty(key))
                errors.push(annot[key].text + " on line " + annot[key].row);
            }
        });*/

        editor.setOptions({
            maxLines: 5,
            minLines: 5
        });

    });
</script>

<style>
    .text-editor{
        width: 100%;
        height: 100%;
        border: none;
        outline: none;
        resize: none;
        font-size: 1rem;
        position: relative;
        border: 1px solid var(--background3);
    }
</style>

<div class="text-editor" id={id}></div>
{#if errors.length > 0}
    {#each errors as error}
        <p class="alert-error">{error}</p>
    {/each}
{/if}