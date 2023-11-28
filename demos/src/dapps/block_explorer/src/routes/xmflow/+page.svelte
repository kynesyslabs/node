<script>
	import { writable } from 'svelte/store';

	import { SvelteFlow, Controls, Background, BackgroundVariant, MiniMap, useSvelteFlow } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import OperationNode from './OperationNode.svelte';
	//import uuid
	import { v4 as uuidv4 } from 'uuid';
	import { Operation } from '$lib/chainscript';

	import Drawer from './Drawer.svelte';
	import ConditionalNode from './ConditionalNode.svelte';
	import EqualsNode from './EqualsNode.svelte';
	import StartNode from './StartNode.svelte';
	import TaskNode from './TaskNode.svelte';

    import cloneDeep from 'lodash/cloneDeep';
	import { get } from 'svelte/store';

    const { screenToFlowCoordinate } = useSvelteFlow();

	// We are using writables for the nodes and edges to sync them easily. When a user drags a node for example, Svelte Flow updates its position. This also makes it easier to update nodes in user land.
	const nodes = writable([
		{
			id: "start",
			type: 'start',
			data: {},
			position: {x:0, y:0},
			selectable:false
		}
	]);

	// same for edges
	const edges = writable([
	]);

	let temp_required = [];

	let required_connections = writable([]);

	function checkRequired(nodes, edges, myedge)
	{
		if(!myedge)
		{
			consolidateRequired();
			return
		}
		const targetnode = nodes.find(node=>node.id==myedge.target);
		if(!targetnode)
		{
			consolidateRequired();
			return
		}
		//this does not need to consolidate because the transaction must go on even without a chain selected
		const chain = targetnode?.data?.operation?.chain;
		if(!chain)
			return
		if(temp_required.findIndex(rq=>rq==chain) == -1)
		{
			temp_required.push(chain);
		}
		checkRequired(nodes, edges, edges.find(edge=>edge.source==myedge.target))
	}

	function calculateRequired(nodes, edges){
		temp_required = [];
		checkRequired(nodes, edges, edges.find(edge=>edge.source=="start"))
	}

	function consolidateRequired(){
		let required_copy = cloneDeep(get(required_connections));
		//remove connections that are not required anymore
		required_copy.forEach((rq, index) => {
			//find the index of the chain in the temp array
			const connection_index = temp_required.findIndex(temp_chain=>temp_chain==rq.id);
			//if chain does not exist in the temp array, remove it from the actual one
			if(connection_index == -1)
			{
				required_copy.splice(index, 1);
			}
		});
		//add connections that are required
		temp_required.forEach((chain) =>{
			const chain_index = required_copy.findIndex(rq=>rq.id==chain);
			if(chain_index == -1)
			{
				required_copy.push({id:chain, wallet:null});
			}
		})
		required_connections.set(required_copy);
	}

	$:calculateRequired($nodes, $edges);

	const nodeTypes = {
		'start': StartNode,
		'operation': OperationNode,
        'pay':TaskNode,
        'contract_read':TaskNode,
        'conditional':ConditionalNode,
        'equals':EqualsNode,
	};

	//d&d functionality
	const onDragOver = (event) => {
		event.preventDefault();

		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	};

	const onDrop = (event) => {
		event.preventDefault();

		if (!event.dataTransfer) {
			return null;
		}

		const type = event.dataTransfer.getData('application/svelteflow');

		const position = screenToFlowCoordinate({
			x: event.clientX,
			y: event.clientY
		});

		const newId = uuidv4();
		let data = {};
		if(type=="pay"||type=="contract_read")
		data = { id:newId, operation:new Operation({tasktype:type})};
		const newNode = {
			id: newId,
			type,
			position,
			data: data,
			origin: [0.5, 0.0],
			selectable:false
		};

		$nodes.push(newNode);
		$nodes = $nodes;
	};
</script>

<main>
	<SvelteFlow
		{nodeTypes}
		{nodes}
		{edges}
		fitView
        on:dragover={onDragOver} on:drop={onDrop}
		on:connect={(event) => console.log('on connect', event)}
		on:connectstart={(event) => console.log('on connect start', event)}
	>
		<Controls />
		<Background variant={BackgroundVariant.Dots} bgColor={"var(--background)"} patternColor={"var(--background4)"} />
		<MiniMap />
	</SvelteFlow>
	<Drawer required_connections={required_connections}/>
</main>

<style>
	main {
		height: 100vh;
        display: flex;
    flex-direction: column-reverse;
	}
</style>
