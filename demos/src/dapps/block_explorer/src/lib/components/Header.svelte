<script>
    import '$lib/global.css';

</script>

<style>
    .logo{
        width: 150px;
        margin: 24px 32px;
    }
    .header{
        background: rgba(255, 255, 255, 0.02);
        backdrop-filter: blur(15px);
        width: 100%;
    }
</style>

<div class="header">
    <a href="/">
        <div>
            <img alt="logo" class="logo" src="/LOGOMorph.svg"/>
        </div>
    </a>
</div>

<!--<div class="container">
    <video class="video" autoplay muted loop>
        <source src={video} type="video/mp4"/>
    </video>
    <div class="header-body">
        <h1>Demos</h1>
        <h2 class="subtitle">Block explorer</h2>
        <div class="inputComponent">
            <p class="label">Search by hash</p>
            <form on:submit={(e)=>{e.preventDefault();onSearch(e.target.elements.hash.value)}} class="inputContainer">
                <input class="inputElement" name="hash" placeholder=""/>
                <button type="submit" class="inputButton"><Fa style="cursor:pointer;" icon={faMagnifyingGlass}></Fa></button>
            </form>
        </div>
    </div>
</div>-->