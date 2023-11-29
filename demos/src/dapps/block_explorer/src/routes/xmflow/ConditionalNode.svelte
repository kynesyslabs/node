<script>
    import { Handle, Position } from '@xyflow/svelte';
</script>
<div class="card operation">
	<Handle type="target" style="top:26px;" position={Position.Left} />
    <p>IF</p>
    <p></p>
    <p></p>
    <p class="align-right">THEN</p>
    <p></p>
    <p class="align-right">ELSE</p>
	<Handle type="source" style="top:50%;" position={Position.Right} />
	<Handle type="source" style="top:calc(100% - 26px);" position={Position.Right} />
</div>

<style>
    .operation{
        padding: 0 24px;
        position: relative;
        gap: 0 16px;
        display: grid;
        grid-template-columns: 50px 50px;
    }
    .align-right{
        text-align: right;
    }
</style>