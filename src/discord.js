// Description:
//   Adapter for Hubot to communicate on Discord
//
// Commands:
//   None
//
// Configuration:
//   HUBOT_DISCORD_TOKEN          - authentication token for bot
//   HUBOT_DISCORD_STATUS_MSG     - Status message to set for "currently playing game"

import {Robot, Response, Adapter, EnterMessage, LeaveMessage, TopicMessage, TextMessage, User} from "hubot"

import Discord from "discord.js"

import ReactionMessage from "./reaction-message.js"

const TextChannel = Discord.TextChannel;

//Settings
const currentlyPlaying = process.env.HUBOT_DISCORD_STATUS_MSG || '';

Robot.prototype.react = function (matcher, options, callback) {
  var matchReaction;
  // this function taken from the hubot-slack api
  matchReaction = function (msg) {
    return msg instanceof ReactionMessage;
  };
  if (arguments.length === 1) {
    return this.listen(matchReaction, matcher);
  } else if (matcher instanceof Function) {
    matchReaction = function (msg) {
      return msg instanceof ReactionMessage && matcher(msg);
    };
  } else {
    callback = options;
    options = matcher;
  }
  return this.listen(matchReaction, options, callback);
};

Response.prototype.react = function () {
  var strings;
  strings = [].slice.call(arguments);
  return this.runWithMiddleware.apply(this, [
    'react',
    {
      plaintext: true
    }
  ].concat(strings));
};

export class DiscordBot extends Adapter {
  constructor(robot) {
    super(robot);

    this.rooms = {};
    this.robot = robot
    if (process.env.HUBOT_DISCORD_TOKEN == null) {
      this.robot.logger.error("Error: Environment variable named `HUBOT_DISCORD_TOKEN` required");
      return;
    }
  }

  run() {
    this.options = {
      token: process.env.HUBOT_DISCORD_TOKEN
    };
    this.client = new Discord.Client({
      autoReconnect: true,
      fetch_all_members: true,
      api_request_method: 'burst',
      intents: ["Guilds", "GuildMembers", "MessageContent", "GuildMessages"],
      ws: {
        compress: true,
        large_threshold: 1000
      }
    });
    this.robot.client = this.client;

    this.client.on('threadCreate', this.joinThread);
    this.client.on('ready', this.ready);
    this.client.on('messageCreate', this.message);
    // Treat message edits as new messages, for now.
    this.client.on('messageUpdate', this.message);
    this.client.on('guildMemberAdd', this.enter);
    this.client.on('guildMemberRemove', this.leave);
    this.client.on('disconnected', this.disconnected);
    this.client.on('error', (error) => {
      return this.robot.logger.error(`The client encountered an error: ${error}`);
    });
    this.client.on('messageReactionAdd', (message, user) => {
      return this.message_reaction('reaction_added', message, user);
    });
    this.client.on('messageReactionRemove', (message, user) => {
      return this.message_reaction('reaction_removed', message, user);
    });
    return this.client.login(this.options.token).catch(this.robot.logger.error);
  }

  mapUser(discord_user, channel_id) {
    const user = this.robot.brain.userForId(discord_user.id);
    user.room = channel_id;
    user.name = discord_user.username;
    user.discriminator = discord_user.discriminator;
    user.id = discord_user.id;
    return user;
  }

  formatIncomingMessage(message) {
    var base, matches, name, ref, text;
    if ((base = this.rooms)[name = message.channel.id] == null) {
      base[name] = message.channel;
    }
    text = (ref = message.content) != null ? ref : message.cleanContent;
    // If content starts by mentioning me `<@!1234567890>`, rewrite to `@myname` so Hubot understands it
    matches = text.match(new RegExp(`^<@!${this.client.user.id}>`));
    if (matches) {
      text = `${this.robot.name} ${text.substr(matches[0].length)}`;
    }
    if ((message != null ? message.channel : void 0) instanceof Discord.DMChannel) {
      if (!text.match(new RegExp(`^@?${this.robot.name}`))) {
        text = `${this.robot.name}: ${text}`;
      }
    }
    return text;
  }

  joinThread = async (thread) => {
    await thread.join()
  }

  hasPermission = (channel, user) => {
    var isText, permissions;
    isText = channel !== null && channel.type === 'text';
    permissions = isText && channel.permissionsFor(user);
    if (isText) {
      return permissions !== null && permissions.hasPermission("SEND_MESSAGES");
    } else {
      return channel.type !== 'text';
    }
  }

  sendSuccessCallback = (adapter, channel, message) => {
    return adapter.robot.logger.debug(`SUCCESS! Message sent to: ${channel.id}: ${message}`);
  }

  sendFailCallback = (adapter, channel, message, error) => {
    adapter.robot.logger.debug(`ERROR! Message not sent: ${message}\r\n${error}`);
    // check owner flag and prevent loops
    if (process.env.HUBOT_OWNER && channel.id !== process.env.HUBOT_OWNER) {
      return sendMessage(process.env.HUBOT_OWNER, `Couldn't send message to ${channel.name} (${channel}) in ${channel.guild.name}, contact ${channel.guild.owner} to check permissions`);
    }
  }

  getChannel = (channelId) => {
    var channel, channels;
    if (this.rooms[channelId] != null) {
      channel = this.rooms[channelId];
    } else {
      channels = this.client.channels.filter(function (channel) {
        return channel.id === channelId;
      });
      if (channels.first() != null) {
        channel = channels.first();
      } else {
        channel = this.client.users.get(channelId);
      }
    }
    return channel;
  }

  //----- private above, public below -----

  ready = () => {
    var channel, i, len, ref;
    this.robot.logger.info(`Logged in: ${this.client.user.username}#${this.client.user.discriminator}`);
    this.robot.name = this.client.user.username;
    this.robot.logger.info(`Robot Name: ${this.robot.name}`);
    this.emit("connected");
    ref = this.client.channels;
    for (i = 0, len = ref.length; i < len; i++) {
      channel = ref[i];
      //post-connect actions
      this.rooms[channel.id] = channel;
    }
    return this.client.user.setActivity(currentlyPlaying).then(this.robot.logger.debug(`Status set to ${currentlyPlaying}`)).catch(this.robot.logger.error);
  }

  enter = (member) => {
    var user;
    user = member;
    this.robot.logger.debug(`${user} Joined`);
    return this.robot.receive(new EnterMessage(user));
  }

  leave = (member) => {
    var user;
    user = member;
    this.robot.logger.debug(`${user} Left`);
    return this.robot.receive(new LeaveMessage(user));
  }

  message = (message) => {
    var text, user;
    // ignore messages from myself
    if (message.author.id === this.client.user.id) {
      return;
    }
    user = this.mapUser(message.author, message.channel.id);
    text = this.formatIncomingMessage(message);
    this.robot.logger.debug(text);
    return this.robot.receive(new TextMessage(user, text, message.id));
  }

  message_reaction = (reaction_type, message, user) => {
    var author, reaction, reactor, text, text_message;

    // ignore reactions from myself
    if (user.id === this.client.user.id) {
      return;
    }
    reactor = this.mapUser(user, message.message.channel.id);
    author = this.mapUser(message.message.author, message.message.channel.id);
    text = this.formatIncomingMessage(message.message);
    text_message = new TextMessage(reactor, text, message.message.id);
    reaction = message._emoji.name;
    if (message._emoji.id != null) {
      reaction += `:${message._emoji.id}`;
    }
    return this.robot.receive(new ReactionMessage(reaction_type, reactor, reaction, author, text_message, message.createdTimestamp));
  }

  disconnected = () => {
    return this.robot.logger.info(`${this.robot.name} Disconnected, will auto reconnect soon...`);
  }

  send(envelope, ...messages) {
    var i, len, message, results;
    results = [];
    for (i = 0, len = messages.length; i < len; i++) {
      message = messages[i];
      results.push(this.sendMessage(envelope.room, message));
    }
    return results;
  }

  reply(envelope, ...messages) {
    var i, len, message, results;
    results = [];
    for (i = 0, len = messages.length; i < len; i++) {
      message = messages[i];
      results.push(this.sendMessage(envelope.room, `<@${envelope.user.id}> ${message}`));
    }
    return results;
  }

  sendMessage(channelId, message) {
    var channel, ref, ref1, that, zSWC;
    //Padded blank space before messages to comply with https://github.com/meew0/discord-bot-best-practices
    zSWC = "\u200B";
    message = zSWC + message;
    channel = this.getChannel(channelId);
    that = this;
    // check permissions
    if (channel && (!(channel instanceof TextChannel) || this.hasPermission(channel, (ref = this.robot) != null ? (ref1 = ref.client) != null ? ref1.user : void 0 : void 0))) {
      return channel.send(message, {
        split: true
      }).then(function (msg) {
        return that._send_success_callback(that, channel, message, msg);
      }).catch(function (error) {
        return that._send_fail_callback(that, channel, message, error);
      });
    } else {
      return this.sendFailCallback(this, channel, message, "Invalid Channel");
    }
  }

  react(envelope, ...reactions) {
    var channel, i, len, messageId, reaction, ref, ref1, results, robot, that;
    robot = this.robot;
    channel = this.getChannel(envelope.room);
    that = this;
    messageId = envelope.message instanceof ReactionMessage ? envelope.message.item.id : envelope.message.id;
    if (channel && (!(channel instanceof TextChannel) || this.hasPermission(channel, (ref = this.robot) != null ? (ref1 = ref.client) != null ? ref1.user : void 0 : void 0))) {
      results = [];
      for (i = 0, len = reactions.length; i < len; i++) {
        reaction = reactions[i];
        this.robot.logger.info(reaction);
        results.push(channel.fetchMessage(messageId).then(function (message) {
          return message.react(reaction).then(function (msg) {
            return that._send_success_callback(that, channel, message, msg);
          }).catch(function (error) {
            return that._send_fail_callback(that, channel, message, error);
          });
        }).catch(function (error) {
          return that._send_fail_callback(that, channel, reaction, error);
        }));
      }
      return results;
    } else {
      return this.sendFailCallback(this, channel, message, "Invalid Channel");
    }
  }

  channelDelete(channel, client) {
    var roomId, user;
    roomId = channel.id;
    user = new User(client.user.id);
    user.room = roomId;
    user.name = client.user.username;
    user.discriminator = client.user.discriminator;
    user.id = client.user.id;
    this.robot.logger.info(`${user.name}#${user.discriminator} leaving ${roomId} after a channel delete`);
    return this.robot.receive(new LeaveMessage(user, null, null));
  }

  guildDelete(guild, client) {
    var channel, results, room, roomIds, serverId, user;
    serverId = guild.id;
    roomIds = (function () {
      var i, len, ref, results;
      ref = guild.channels;
      results = [];
      for (i = 0, len = ref.length; i < len; i++) {
        channel = ref[i];
        results.push(channel.id);
      }
      return results;
    })();
    results = [];
    for (room in rooms) {
      user = new User(client.user.id);
      user.room = room.id;
      user.name = client.user.username;
      user.discriminator = client.user.discriminator;
      user.id = client.user.id;
      this.robot.logger.info(`${user.name}#${user.discriminator} leaving ${roomId} after a guild delete`);
      results.push(this.robot.receive(new LeaveMessage(user, null, null)));
    }
    return results;
  }

};

export function use(robot) {
  return new DiscordBot(robot);
}

