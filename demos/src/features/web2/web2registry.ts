import { Web2Data } from "src/features/web2"
// INFO This singleton is used to store the state of the application through different parts of the application.

export default class web2Registry {
    private static instance: web2Registry

    private registry: Record<string, Web2Data>

    constructor() {
        this.registry = {}
    }

    public static getInstance(): web2Registry {
        if (!web2Registry.instance) {
            web2Registry.instance = new web2Registry()
        }
        return web2Registry.instance
    }

    public addEntry(web2Data: Web2Data): void {
        this.registry[
            web2Data.data.request.url + web2Data.data.request.timestamp
        ] = web2Data
    }

    public updateEntry(web2Data: Web2Data): void {
        this.registry[
            web2Data.data.request.url + web2Data.data.request.timestamp
        ] = web2Data
    }

    public getEntry(web2Data: Web2Data): void {
        this.registry[
            web2Data.data.request.url + web2Data.data.request.timestamp
        ] = web2Data
    }

    public removeEntry(web2Data: Web2Data): void {
        delete this.registry[
            web2Data.data.request.url + web2Data.data.request.timestamp
        ]
    }
}
