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

  constructor(web2Request: IWeb2Request) {
    this._web2Request = web2Request
    this.proxy = new Proxy(this)
  }

  get web2Request(): IWeb2Request {
    return this._web2Request
  }

  async talkWithTarget(
      source: string, 
      target: IWeb2Request,
      path: string, 
      method: IRawWeb2Request["method"]): Promise<IWeb2Attestation> {
          const web2RequestManager = new Web2RequestManager(this)
          const getWeb2Attestation = web2RequestManager.getAttestation
          const web2Promise = this.proxy.sendHTTPRequest(source, target, path, method)
          const attestedPromise = getWeb2Attestation(web2Promise)

          return attestedPromise
  }

  stopTalkWithTarget(): void {
      this.proxy.stopProxy()
  }
}