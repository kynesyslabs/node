<script>
    import CodeEditor from "$lib/components/CodeEditor.svelte";
    export let required
    export let label;
    export let value;
    export let onChange;
    export let type;
    $: if(!value)value="";
</script>


<div style="width: 100%;">
    <p class="label">{label}<span style="opacity:.6;">{!required?" (optional)":""}</span></p>
    {#if type=="json"}
        <CodeEditor id={label} text={value} onChange={onChange}/>
    {:else}
        <input class="smallinput" on:input={(ev)=>{onChange(ev.target.value)}} value={value}/>
    {/if}
</div>
