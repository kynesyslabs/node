import {
  IRawWeb2Request,
  IWeb2Attestation,
  IWeb2Request,
} from "@kynesyslabs/demosdk/types"

import { Web2RequestManager } from "src/features/web2/Web2RequestManager"
import { Proxy } from "src/features/web2/dahr/Proxy"

export class DAHR {
  private proxy: Proxy

  /** 
   * The web2 request.
   * @type {IWeb2Request}
   */
  private _web2Request: IWeb2Request

  /**
   * Constructor for the DAHR class.
   */
  constructor(web2Request: IWeb2Request) {
    this._web2Request = web2Request
  }

  /**
   * Get the web2Request.
   * @returns {IWeb2Request} The HTTP web2Request.
   */
  get web2Request(): IWeb2Request {
    return this._web2Request
  }

  /**
   * Initialize a DAHR instance.
   * @param {string} source - The source.
   * @param {string} target - The target.
   */
  initializeDAHR(source: string, target: string) {
      this.proxy = new Proxy(source, target, this)
  }

  /**
   * Talk with the target.
   * @returns {Promise<any>} The attested result.
   */
  async talkWithTarget(
      path: string, 
      body: IRawWeb2Request | null, 
      method: IRawWeb2Request["method"]): Promise<IWeb2Attestation> {
          const web2RequestManager = new Web2RequestManager(this)
          const attestWeb2Result = web2RequestManager.attest

          const web2Result = await this.proxy.send(body, path, method)
          const attestedResult = attestWeb2Result(web2Result)
          return attestedResult
  }

  /**
   * Stop talking with the target.
   */
  stopTalking() {
      this.proxy.stop()
  }
}