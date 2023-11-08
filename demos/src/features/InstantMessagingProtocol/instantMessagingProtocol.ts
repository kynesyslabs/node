// INFO The IMP is not only used as a messaging system (like, on instant messengers) but also as a way of communicating within DEMOS
// network without having to be on chain all the time (sort like Lightning Network)

import Cryptography from "src/libs/crypto/cryptography"
import Hashing from "src/libs/crypto/hashing"
import { demostdlib } from "src/libs/utils"
import InstantMessagingChannel from "./types/InstantMessagingChannel"

export default class InstantMessagingProtocol {
	private static channels: Map<string, InstantMessagingChannel> = new Map()
	private static banner: string = "DEMOS Instant Messaging Protocol"

	constructor(banner: string) {
		InstantMessagingProtocol.banner = banner
    }

	// INFO Get all the instant messaging channels
	public static async getChannels(): Promise<Map<string, InstantMessagingChannel>> {
		return InstantMessagingProtocol.channels
    }

	// INFO Get a specific instant messaging channel
	public static async getChannel(channelId: string): Promise<InstantMessagingChannel> {
        return InstantMessagingProtocol.channels.get(channelId)
    }

	// TODO
	// INFO Create a new instant messaging channel
	public static async createChannel(): Promise<any> {
		let channel = new InstantMessagingChannel()
		// TODO
		let id = channel.getID()
		InstantMessagingProtocol.channels.set(id, channel)
		return id
	}

	// TODO
	// INFO Join an instant messaging channel
	public static async joinChannel(): Promise<any> {
    }

	// TODO
	// INFO Leave an instant messaging channel
	public static async leaveChannel(): Promise<any> {
    }

	
}