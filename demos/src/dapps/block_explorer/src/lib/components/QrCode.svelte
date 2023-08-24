
<script>
    import QRCode from 'qrcode';
	import { onMount } from "svelte";
    export let data;

    onMount(()=>{
        QRCode.toCanvas(document.getElementById('canvas'), data, function (error) {
            if (error) console.error(error)
        })
    })
</script>

<canvas id="canvas"></canvas>
