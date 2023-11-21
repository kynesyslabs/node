<style>
    .cube-container{
        margin: 64px 0;
        position: relative;
    }
    .cube {
        -webkit-transform-style: preserve-3d;
        -webkit-animation: spin 3s infinite ease-out;
        position: relative;
        width: 100px;
        height: 100px;
        top: 50%;
        left: 50%;
        margin-left: -50px;
        margin-top: 64px;
        margin-bottom: 128px;
    }

    .cube div {
        width: 100px;
        height: 100px;
        line-height: 100px;
        text-align: center;
        display: block;
        position: absolute;
        border: 2px solid var(--color);
    }

    .cube div.top {
        -webkit-transform: rotateX(90deg); 
        margin-top: -50px;
    }

    .cube div.right {
        -webkit-transform: rotateY(90deg); 
        margin-left: 50px;
    }

    .cube div.bottom {
        -webkit-transform: rotateX(-90deg); 
        margin-top: 50px;
    }

    .cube div.left {
        -webkit-transform: rotateY(-90deg); 
        margin-left: -50px;
    }

    .cube div.front {
        -webkit-transform: translateZ(50px);
    }

    .cube div.back {
        -webkit-transform: translateZ(-50px) rotateX(180deg);
    }

    @-webkit-keyframes spin {
        0% {-webkit-transform: rotateX(-20deg) rotateY(20deg);}
        100% {-webkit-transform: rotateX(-20deg) rotateY(740deg);}
    }
</style>

<div class="cube-container">
    <div class="cube">
        <div class="top"></div>
        <div class="right"></div>
        <div class="bottom"></div>
        <div class="left"></div>
        <div class="front"></div>
        <div class="back"></div>
    </div>
</div>