<script>
    export let transition;
</script>

<style>
    .cardWrap {
        padding: 1px 0 0 1px;
        position: relative;
        z-index: 2;
        border-radius: 14px; 
        background: linear-gradient(28deg,  #000000,#000000, rgba(255, 255, 255, 0.5), #000000, #000000 );
    }

    .cardWrap::before {
        content: "";
        left: 1px;
        top: 1px;
        width: calc(100% - 1px);
        height: calc(100% - 1px);
        background: #000;
        position: absolute;
        z-index: 1;
        border-radius: 14px;
    }

    .cardInnerWrap {
        position: relative;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(15px);
        padding: 40px;
        z-index: 2;
    }

    @media (max-width: 1199px) {
        .cardWrap {
            border-radius: 13px; 
        }
        
        .cardWrap::before {
            border-radius: 13px;
        }
        
        .cardInnerWrap {
            border-radius: 13px;
            padding: 30px;
        }
    }

    @media (max-width: 991px) {
        .cardWrap {
            border-radius: 12px; 
        }
        
        .cardWrap::before {
            border-radius: 12px;
        }
        
        .cardInnerWrap {
            border-radius: 12px;
            padding: 30px;
        }
    }

    @media (max-width: 991px) {
        .cardWrap {
            border-radius: 10px; 
        }
        
        .cardWrap::before {
            border-radius: 10px;
        }
        
        .cardInnerWrap {
            border-radius: 10px;
            padding: 20px;
        }
    }
</style>

<div class="cardWrap">
    <div class="cardInnerWrap">
        <slot/>
    </div>
</div>