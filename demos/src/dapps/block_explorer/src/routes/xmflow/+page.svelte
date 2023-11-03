<script lang="ts">
	import { writable } from 'svelte/store';
	import { SvelteFlow, Controls, Background, BackgroundVariant, MiniMap, useSvelteFlow, SvelteFlowProvider } from '@xyflow/svelte';
	import OperationNode from './OperationNode.svelte';

	// you need to import the styles for Svelte Flow to work
	// if you just want to load the basic styleds, you can import '@xyflow/svelte/dist/base.css'
	import '@xyflow/svelte/dist/style.css';
	import Drawer from './Drawer.svelte';
	import PayNode from './PayNode.svelte';
	import ReadContractNode from './ReadContractNode.svelte';
	import ConditionalNode from './ConditionalNode.svelte';
	import EqualsNode from './EqualsNode.svelte';

    const { screenToFlowCoordinate } = useSvelteFlow();

	// We are using writables for the nodes and edges to sync them easily. When a user drags a node for example, Svelte Flow updates its position. This also makes it easier to update nodes in user land.
	const nodes = writable([
	]);

	// same for edges
	const edges = writable([
		{
			id: '1-2',
			type: 'default',
			source: '1',
			target: '2',
			label: 'Edge Text'
		}
	]);

	const nodeTypes = {
		'color-picker': OperationNode,
		'operation': OperationNode,
        'pay':PayNode,
        'readcontract':ReadContractNode,
        'conditional':ConditionalNode,
        'equals':EqualsNode,
	};

	//d&d functionality
	const onDragOver = (event: DragEvent) => {
		event.preventDefault();

		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();

		if (!event.dataTransfer) {
			return null;
		}

		const type = event.dataTransfer.getData('application/svelteflow');

		const position = screenToFlowCoordinate({
			x: event.clientX,
			y: event.clientY
		});

		const newNode = {
			id: `${Math.random()}`,
			type,
			position,
			data: { label: `${type} node` },
			origin: [0.5, 0.0]
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
		on:nodeclick={(event) => console.log('on node click', event)}
        on:dragover={onDragOver} on:drop={onDrop}
	>
		<Controls />
		<Background variant={BackgroundVariant.Dots} />
		<MiniMap />
	</SvelteFlow>
	<Drawer />
</main>

<style>
	main {
		height: 100vh;
        display: flex;
    flex-direction: column-reverse;
	}
</style>
