<script>
    import {rpcaddress, updateRpcAddress} from "$lib/env.js";
    import Combobox from "$lib/components/inputs/Combobox.svelte";
    let initial = $rpcaddress;
    let addresses = [
        {id: initial, label:initial}
    ]
</script>

<Combobox options={addresses} value={$rpcaddress} onChange={(v)=>{updateRpcAddress(v)}}/>