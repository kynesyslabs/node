<script>
	import ChainSelection from './ChainSelection.svelte';
    import CodeEditor from '$lib/components/CodeEditor.svelte';
	import TaskNode from './TaskNode.svelte';

    export let data;

    const {id} = data;

    let abi;
    function updateAbi(newValue)
    {
        abi = newValue;
    }

    let params;
    function updateParams(newValue)
    {
        params = newValue;
    }

    let chain;
    function updateChain(newValue)
    {
        chain = newValue;
    }
</script>

<TaskNode label="Read Contract">
        <div class="input-box">
            <label>Chain</label>
            <ChainSelection value={chain} onChange={updateChain}></ChainSelection>
        </div>
        <div class="input-box">
            <label>Address</label>
            <input/>
        </div>
        <div class="input-box">
            <label>ABI</label>
            <CodeEditor id={`abi${id}`} text={abi} onChange={updateAbi}></CodeEditor>
        </div>
        <div class="input-box">
            <label>Method</label>
            <input/>
        </div>
        <div class="input-box">
            <label>Params <span style="opacity: .5;">(optional)</span></label>
            <CodeEditor id={`params${id}`} text={params} onChange={updateParams}/>
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