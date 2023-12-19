<script lang="ts">
    import { blockIcons } from '$lib/chainscript.js';
    export let closeDrawer;
	const onDragStart = (event: DragEvent, nodeType: string) => {
        closeDrawer();

		if (!event.dataTransfer) {
			return null;
		}

		event.dataTransfer.setData('application/svelteflow', nodeType);
		event.dataTransfer.effectAllowed = 'move';
	};
</script>

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
    <div class="card operation" on:dragstart={(event) => onDragStart(event, 'contract_read')}
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

<style>
    .label {
		margin: 1rem 0;
		font-size: 0.9rem;
        opacity: .6;
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