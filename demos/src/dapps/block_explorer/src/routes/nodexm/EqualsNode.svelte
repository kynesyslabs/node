<script>
    import {Anchor, Node} from 'svelvet';
</script>
<style>
    .operation{
        padding: 24px;
        position: relative;
        gap: 16px;
        display: grid;
        grid-template-columns: 50px 50px;
    }
    .operation p {
        margin: 0;
    }
    .input-anchors {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 10px;
		top: 50%;
        transform: translate(0, -50%);
        left: -20px;
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
<Node>
    <div class="input-anchors">
        <Anchor input></Anchor>
        <Anchor input></Anchor>
    </div>
    <div class="output-anchors">
        <Anchor output></Anchor>
    </div>
    <div class="card operation">
        <p>=</p>
    </div>
</Node>