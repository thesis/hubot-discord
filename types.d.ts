import { Client } from "discord.js";
import { Adapter, Robot } from "hubot";

declare module "hubot-discord" {
	export class DiscordBot extends Adapter {
		constructor(robot: Robot)

		public client: Client | undefined
	}

	export function use(robot: Robot): DiscordBot
}
