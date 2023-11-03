<script>
    import {Anchor, Node} from 'svelvet';
    export let connections;
    $:console.log(connections);
</script>
<style>
    .operation{
        padding: 24px;
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 16px;
    }
	.output-anchors {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 10px;
        top: 50%;
        transform: translate(0, -50%);
        right: -20px;
	}
</style>
<Node id="start" let:connect>
    <div class="output-anchors">
        <Anchor output></Anchor>
    </div>
    <div class="card operation">
        START
    </div>
</Node>