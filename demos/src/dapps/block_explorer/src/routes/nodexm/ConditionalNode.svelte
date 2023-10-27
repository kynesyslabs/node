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
		gap: 16px;
		top: 26px;
        left: -20px;
	}

	.output-anchors {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 24px;
        top: calc(50% - 8px);
        right: -20px;
	}
</style>
<Node>
    <div class="input-anchors">
        <Anchor input></Anchor>
    </div>
    <div class="output-anchors">
        <Anchor output></Anchor>
        <Anchor output></Anchor>
    </div>
    <div class="card operation">
        <p>IF</p>
        <p></p>
        <p></p>
        <p>THEN</p>
        <p></p>
        <p>ELSE</p>
    </div>
</Node>