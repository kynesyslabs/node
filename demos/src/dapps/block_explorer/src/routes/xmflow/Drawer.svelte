<script lang="ts">
    import { blockIcons } from '$lib/chainscript.js';
	const onDragStart = (event: DragEvent, nodeType: string) => {
		if (!event.dataTransfer) {
			return null;
		}

		event.dataTransfer.setData('application/svelteflow', nodeType);
		event.dataTransfer.effectAllowed = 'move';
	};
</script>

<aside class="drawer open">
    <div style="margin-bottom: 32px;">
        <h4>Available blocks</h4>
        <div class="label">You can drag these nodes to the editor pane.</div>
    </div>
	<div class="category">
		<h4 class="blocks-title">Universal Tasks</h4>
		<div class="card operation" on:dragstart={(event) => onDragStart(event, 'pay')}
			draggable={true}>
			<img
				style="opacity: .3;"
				alt="task icon"
				class="taskicon"
				src={blockIcons.find((item) => item.id == 'pay').icon}
			/>
			Pay
        </div>
	</div>
	<div class="category">
		<h4 class="blocks-title">EVM Tasks</h4>
		<div class="card operation" on:dragstart={(event) => onDragStart(event, 'readcontract')}
			draggable={true}>
			<img
				style="opacity: .3;"
				alt="task icon"
				class="taskicon"
				src={blockIcons.find((item) => item.id == 'contract_read').icon}
			/>
			Read Contract
		</div>
	</div>
	<div class="category">
		<h4 class="blocks-title">Logic</h4>
		<div class="card operation" on:dragstart={(event) => onDragStart(event, 'conditional')}
			draggable={true}>
			<img
				style="opacity: .3;"
				alt="task icon"
				class="taskicon"
				src={blockIcons.find((item) => item.id == 'conditional').icon}
			/>
			IF Statement
		</div>
		<div class="card operation" on:dragstart={(event) => onDragStart(event, 'equals')}
			draggable={true}>
			<img
				style="opacity: .3;"
				alt="task icon"
				class="taskicon"
				src={'/task-icons/equal-sign.svg'}
			/>
			Condition Equals
		</div>
	</div>
</aside>

<style>
	.label {
		margin: 1rem 0;
		font-size: 0.9rem;
        opacity: .6;
	}

	.drawer {
		max-width: 616px;
		height: 100dvh;
		position: fixed;
		left: 0;
		top: 0;
		padding: 24px;
		border-top: none;
		border-bottom: none;
		border-left: none;
		transition: transform 0.3s ease-in-out;
		z-index: 1000;
		border-right: 1px solid var(--background3);
		background-color: var(--background);
		transform: translate(100%, 0);
	}
	.open {
		transform: translate(0, 0);
	}
	.category {
		margin-bottom: 32px;
	}
	.blocks-title {
		opacity: 0.6;
	}
	.operation {
		padding: 24px;
		position: relative;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
	}
	.taskicon {
		width: 24px;
		height: 24px;
	}
</style>
