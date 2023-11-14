export default class InstantMessagingChannel {
	private channelId: string = ""

	constructor(channelId: string = "") {
		this.channelId = channelId
    }

	getID(): string {
		return this.channelId
    }

}