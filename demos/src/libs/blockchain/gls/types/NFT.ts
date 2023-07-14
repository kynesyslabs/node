// NOTE Each NFT has its own property
interface singleNFTProperty {
	name: string;
	value: string;
}

// NOTE A single NFT of a collection
class SingleNFT {
	id: number;
	image: string;
	properties: singleNFTProperty[];

	constructor(id: number, image: string, properties: singleNFTProperty[]) {
			this.id = id;
			this.image = image;
			this.properties = properties;
	}
}

// NOTE A NFT collection
export default class NFT {
	address: string;
	name: string;
	ticker: string;
	description: string;
	main_image: string;
	items: SingleNFT[];

	constructor() {
		this.address = "";
        this.name = "";
        this.ticker = "";
        this.description = "";
        this.main_image = "";
        this.items = [];
	}

	// INFO Adding a new item to the NFT items list
	setItem(image: string, properties: singleNFTProperty[]) {
		let id = this.items.length + 1
		this.items.push(new SingleNFT(id, image, properties));
	}
}