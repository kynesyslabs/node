// INFO Handy serializer and deserializer of stuff

export default class EncoDecode {

	constructor(){}

	static serialize(data: any, format: string = "hex") {
		if (typeof(data) === "string") {
			data = Buffer.from(data)
		}
		return data.toString(format)
	}

	static deserialize(data: any, format: string = "hex") {
		if (typeof(data) === "string") {
            data = Buffer.from(data)
        }
        // TODO
    }
}