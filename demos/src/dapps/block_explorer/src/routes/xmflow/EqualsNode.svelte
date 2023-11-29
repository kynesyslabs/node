<script>
    import { Handle, Position } from '@xyflow/svelte';
</script>
<div class="card operation">
	<Handle type="target" id="1" style="top:25%;" position={Position.Left} />
	<Handle type="target" id="2" style="top:75%;" position={Position.Left} />
    <p>=</p>
	<Handle type="source" position={Position.Right} />
</div>

<style>
    .operation
    {
        padding: 0 48px;
    }
</style>