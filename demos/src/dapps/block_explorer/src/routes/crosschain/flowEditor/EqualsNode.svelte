<script>
    import { Position } from '@xyflow/svelte';
	import OnePathHandle from './OnePathHandle.svelte';
    export let data;
</script>
<div class="card operation">
	<OnePathHandle nodeId={data.id} type="target" id="element1" style="top:25%;" position={Position.Left} />
	<OnePathHandle nodeId={data.id} type="target" id="element2" style="top:75%;" position={Position.Left} />
    <p>=</p>
	<OnePathHandle nodeId={data.id} type="source" id="result" position={Position.Right} />
</div>

<style>
    .operation
    {
        padding: 0 48px;
    }
</style>