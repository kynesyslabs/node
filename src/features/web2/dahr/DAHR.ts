import { IRawWeb2Request, IWeb2Request } from "@kynesyslabs/demosdk/types"
import { Web2RequestManager } from "src/features/web2/Web2RequestManager"
import { Proxy } from "src/features/web2/dahr/Proxy"
import required from "src/utilities/required"

export class DAHR {
    private _proxy: Proxy
    private _web2Request: IWeb2Request

    constructor() {
        this._proxy = new Proxy(this)
    }

    get web2Request(): IWeb2Request {
        return this._web2Request
    }

    set web2Request(request: IWeb2Request) {
        this._web2Request = request
    }

    async talkWithTarget(
        source: string,
        path: string,
        method: IRawWeb2Request["method"],
    ): Promise<any> {
        // Make sure we have a web2Request at this point
        required(this._web2Request, "web2Request")

        const web2RequestManager = new Web2RequestManager(this)
        const web2Response = await this._proxy.sendHTTPRequest(
            source,
            this._web2Request,
            path,
            method,
        )

        const attestedResult = await web2RequestManager.getAttestedResult(
            web2Response,
        )

        return {
            ...attestedResult,
            targetResponse: web2Response,
        }
    }

    stopTalkWithTarget(): void {
        this._proxy.stopProxy()
    }
}
