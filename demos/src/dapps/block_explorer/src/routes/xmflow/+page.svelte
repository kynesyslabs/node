<script>
	import { writable } from 'svelte/store';

	import { SvelteFlow, Controls, Background, BackgroundVariant, MiniMap, useSvelteFlow } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import OperationNode from './OperationNode.svelte';
	//import uuid
	import { v4 as uuidv4 } from 'uuid';
	import { Operation } from '$lib/chainscript';

	import Drawer from './Drawer.svelte';
	import PayNode from './PayNode.svelte';
	import ReadContractNode from './ReadContractNode.svelte';
	import ConditionalNode from './ConditionalNode.svelte';
	import EqualsNode from './EqualsNode.svelte';
	import StartNode from './StartNode.svelte';
	import TaskNode from './TaskNode.svelte';

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

	let required_connections = [];

	function checkRequired(edges, myedge)
	{
		if(!myedge)
			return
		const targetnode = $nodes.find(node=>node.id==myedge.target);
		if(!targetnode)
			return
		/*if(required_connections.findIndex(rq=>rq.id==) == -1)
		required_connections.push({id: operation.data.chain, wallet:null});
        required_connections = required_connections;*/
		checkRequired(edges, edges.find(edge=>edge.source==myedge.target))
	}

	$:checkRequired($edges, $edges.find(edge=>edge.source=="start"));

	const nodeTypes = {
		'start': StartNode,
		'operation': OperationNode,
        'pay':TaskNode,
        'readcontract':ReadContractNode,
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

		const newNode = {
			id: newId,
			type,
			position,
			data: { label: `${type} node`, id:newId, data:new Operation(type)},
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
