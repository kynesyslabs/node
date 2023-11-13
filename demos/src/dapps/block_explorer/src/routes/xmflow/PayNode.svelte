<script lang="ts">
	import { type NodeProps } from '@xyflow/svelte';
    import { v4 as uuidv4 } from 'uuid';
	import TaskNode from './TaskNode.svelte';

	export let data;

    let chain;
    function updateChain(newValue)
    {
        chain = newValue;
    }

    let showoptions = true;

    let node;
    let taskinfo;
    let chaininfo;
    let inputid = uuidv4();

	const { operation } = data;

    function trim_address(str) {
        if (str.length <= 20) 
        return str;
        return str.substr(0, 10) + '...' + str.substr(str.length-4, str.length);
    }
</script>

<TaskNode label="Pay">
    <div class="input-box">
        <label>Address</label>
        <input/>
    </div>
    <div class="input-box">
        <label>Amount</label>
        <input/>
    </div>
</TaskNode>

<style>
    .operation{
        padding: 24px;
    }
    .card-header{
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
    }
    label{
        display: block;
    }
    input{
        display: block;
        width: 100%;
    }
    .input-box{
        margin: 16px 0;
    }
</style>