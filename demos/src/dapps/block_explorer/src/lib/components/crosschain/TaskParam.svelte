<script>
    export let label;
    export let value;
    export let onChange;
    $: if(!value)value="";
</script>
<div style="max-width: 100%;">
    <p class="label">{label}</p>
    <input class="smallinput" on:input={(ev)=>{onChange(ev.srcElement.value)}} value={value}/>
</div>
