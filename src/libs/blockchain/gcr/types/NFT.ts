/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// NOTE Each NFT has its own property
interface SingleNFTProperty {
    name: string
    value: string
}

// NOTE A single NFT of a collection
class SingleNFT {
    id: number
    image: string
    properties: SingleNFTProperty[]

    constructor(id: number, image: string, properties: SingleNFTProperty[]) {
        this.id = id
        this.image = image
        this.properties = properties
    }
}

// NOTE A NFT collection
export default class NFT {
    address: string
    name: string
    ticker: string
    description: string
    main_image: string
    items: SingleNFT[]

    constructor() {
        this.address = ""
        this.name = ""
        this.ticker = ""
        this.description = ""
        this.main_image = ""
        this.items = []
    }

    // INFO Adding a new item to the NFT items list
    setItem(image: string, properties: SingleNFTProperty[]) {
        const id = this.items.length + 1
        this.items.push(new SingleNFT(id, image, properties))
    }
}
