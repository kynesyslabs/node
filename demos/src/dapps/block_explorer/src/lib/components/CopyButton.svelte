<script>
    import Fa from "svelte-fa";
    import {faCopy} from "@fortawesome/free-solid-svg-icons";
    export let text;
    let copied = false;
    function copy(value)
    {
        var aux = document.createElement("input");
        aux.setAttribute("value", value);
        document.body.appendChild(aux);
        aux.select();
        document.execCommand("copy");
        document.body.removeChild(aux);
        copied = true;
    }
    function mouseenterHandler()
    {
        copied = false;
    }
</script>

<button on:click={()=>{copy(text)}} on:mouseenter={mouseenterHandler} class="small-button tooltip color-transition"><span class="tooltiptext">{copied?"Copied!":"Copy"}</span><Fa icon={faCopy}></Fa></button>