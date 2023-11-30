<script>
	import { Handle} from '@xyflow/svelte';
    export let id;
    export let type;
    export let nodeId;
    import { useStore } from '@xyflow/svelte';
    const {edges} = useStore();
    let mySource = null;
    let myTarget = null;
    edges.subscribe(e=>{
        let myTargets = e.filter(e=>e.source==nodeId);
        if (myTargets.length > 0)
        {
            let myFind = myTargets.find(e=>e.sourceHandle==id);
            if(myFind)
            {
                myTarget = myFind.sourceHandle;
            }
            else
            {
                myTarget = null;
            }
        }
        else
        {
            myTarget = null;
        }

        let mySources = e.filter(e=>e.target==nodeId);
        if (mySources.length > 0)
        {
            let myFind = mySources.find(e=>e.targetHandle==id);
            if(myFind)
            {
                mySource = myFind.targetHandle;
            }
            else
            {
                mySource = null;
            }
        }
        else
        {
            mySource = null;
        }
    });
</script>
<Handle isConnectable={type=="target"?mySource?false:true:myTarget?false:true} {...$$props}/>