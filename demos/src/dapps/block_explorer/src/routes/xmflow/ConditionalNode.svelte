<script>
    import { Position } from '@xyflow/svelte';
	import OnePathHandle from './OnePathHandle.svelte';
    export let data;
</script>
<div class="card operation">
	<OnePathHandle nodeId={data.id} type="target" id="if" style="top:26px;" position={Position.Left} />
    <p>IF</p>
    <p></p>
    <p></p>
    <p class="align-right">THEN</p>
    <p></p>
    <p class="align-right">ELSE</p>
	<OnePathHandle nodeId={data.id} type="source" id="then" style="top:50%;" position={Position.Right} />
	<OnePathHandle nodeId={data.id} type="source" id="else" style="top:calc(100% - 26px);" position={Position.Right} />
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