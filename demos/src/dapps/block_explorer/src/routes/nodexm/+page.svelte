<script>
    import { Node, Svelvet, Minimap, Controls, Drawer, ThemeToggle } from 'svelvet';
	import OperationNode from './OperationNode.svelte';
    import {Operation} from "$lib/chainscript.js";
    import { v4 as uuidv4 } from 'uuid';
	import ConditionalNode from './ConditionalNode.svelte';
	import EqualsNode from './EqualsNode.svelte';

</script>

<div style="height:100dvh;">
    <Svelvet id="my-canvas" width="100%" minimap controls theme="dark">
        <OperationNode operation={{id:uuidv4(), label:"Pay", type:"pay", data:new Operation({tasktype:"pay"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Pay", type:"pay", data:new Operation({tasktype:"pay"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Read Contract", type:"contract_read", data:new Operation({tasktype:"contract_read"})}}/>
        <OperationNode operation={{id:uuidv4(), label:"Read Contract", type:"contract_read", data:new Operation({tasktype:"contract_read"})}}/>
        <ConditionalNode/>
        <EqualsNode/>
    </Svelvet>
</div>