import {
  IRawWeb2Request,
  IWeb2Attestation,
  IWeb2Request,
} from "@kynesyslabs/demosdk/types"

import { Web2RequestManager } from "src/features/web2/Web2RequestManager"
import { Proxy } from "src/features/web2/dahr/Proxy"

export class DAHR {
    private proxy: Proxy
    private _web2Request: IWeb2Request

    constructor() {
        this.proxy = new Proxy(this)
    }

    get web2Request(): IWeb2Request {
        return this._web2Request
    }

    async talkWithTarget(
        source: string, 
        web2Request: IWeb2Request,
        path: string, 
        method: IRawWeb2Request["method"]): Promise<IWeb2Attestation> {
            this._web2Request = web2Request
            
            const web2RequestManager = new Web2RequestManager(this)
            const web2Promise = this.proxy.sendHTTPRequest(source, web2Request, path, method)
            const attestedPromise = web2RequestManager.getAttestation(web2Promise)

            return attestedPromise
    }

    stopTalkWithTarget(): void {
        this.proxy.stopProxy()
    }
}