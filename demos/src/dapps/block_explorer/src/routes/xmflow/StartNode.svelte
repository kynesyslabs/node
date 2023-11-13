<script>
	import { Handle, Position } from "@xyflow/svelte";

</script>
<div class="card">
    START
    <Handle type="source" id="start" position={Position.Right}></Handle>
</div>

<style>
    .card{
        background-color: var(--color);
        color: var(--background);
        padding: 24px;
    }
</style>