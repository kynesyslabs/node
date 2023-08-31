<script>
    export let label;
    export let value;
    export let onChange;
    $: if(!value)value="";
</script>
<div>
    <p class="label">{label}</p>
    <input on:input={(ev)=>{onChange(ev.srcElement.value)}} value={value}/>
</div>
