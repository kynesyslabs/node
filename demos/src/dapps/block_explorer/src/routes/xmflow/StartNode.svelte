<script>
	import {Position } from "@xyflow/svelte";
	import OnePathHandle from "./OnePathHandle.svelte";
</script>
<div class="card">
    START
    <OnePathHandle nodeId={"start"} type="source" id="start" position={Position.Right}></OnePathHandle>
</div>

<style>
    .card{
        background-color: var(--color);
        color: var(--background);
        padding: 24px;
    }
</style>