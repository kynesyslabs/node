<script>
    export let data;
    //console.log(data.skeleton);
</script>

<style>
    .container{
        padding: 16px;
    }
</style>

<div class="container">
    <div class="card">
        {#each Object.keys(data.skeleton.content) as key}
            <p>{key}</p>
            <input/>
        {/each}
    </div>
</div>
