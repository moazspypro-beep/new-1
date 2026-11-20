const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const SPAM_WINDOW_MS = 8_000;
const SPAM_MESSAGE_LIMIT = 5;
const WARNING_COOLDOWN_MS = 15_000;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1_000;
const LINK_PATTERN = /(?:https?:\/\/|www\.|discord\.gg\/)[^\s<>()]+/gi;
const allowedDomains = new Set(
  (process.env.ALLOWED_LINK_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean),
);

const messageHistory = new Map();
const warningCooldowns = new Map();
let messagesSinceCleanup = 0;

function logError(context, error) {
  console.error(`[${context}]`, error);
}

async function writeAuditLog(guild, content, allowedMentions = { parse: [] }) {
  const channel = guild.systemChannel;
  if (!channel) {
    console.error(`No system channel is configured for guild ${guild.id}.`);
    return;
  }

  await channel.send({
    content: content.slice(0, 1_900),
    allowedMentions,
  });
}

function isModerator(member) {
  return member.permissions.has(PermissionFlagsBits.ManageMessages)
    || member.permissions.has(PermissionFlagsBits.Administrator);
}

function messageContainsBlockedLink(content) {
  const links = content.match(LINK_PATTERN) || [];
  return links.some((link) => {
    const cleanedLink = link.replace(/[.,!?;:]+$/, "");
    const url = /^https?:\/\//i.test(cleanedLink)
      ? cleanedLink
      : `https://${cleanedLink}`;

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return ![...allowedDomains].some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
    } catch {
      return true;
    }
  });
}

function cleanExpiredEntries(now) {
  for (const [key, timestamps] of messageHistory) {
    const recent = timestamps.filter((timestamp) => now - timestamp < SPAM_WINDOW_MS);
    if (recent.length) messageHistory.set(key, recent);
    else messageHistory.delete(key);
  }

  for (const [key, timestamp] of warningCooldowns) {
    if (now - timestamp >= WARNING_COOLDOWN_MS) warningCooldowns.delete(key);
  }
}

function recordMessage(guildId, userId) {
  const now = Date.now();
  const key = `${guildId}:${userId}`;
  const recent = (messageHistory.get(key) || [])
    .filter((timestamp) => now - timestamp < SPAM_WINDOW_MS);
  recent.push(now);
  messageHistory.set(key, recent);

  messagesSinceCleanup += 1;
  if (messagesSinceCleanup >= 256) {
    cleanExpiredEntries(now);
    messagesSinceCleanup = 0;
  }

  return recent.length >= SPAM_MESSAGE_LIMIT;
}

async function warnInChannel(message, text) {
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (warningCooldowns.get(key) || 0) < WARNING_COOLDOWN_MS) return;

  warningCooldowns.set(key, now);
  await message.channel.send({
    content: `${message.author} ${text}`,
    allowedMentions: { users: [message.author.id] },
  });
}

function parseTimeout(value) {
  const match = /^([1-9]\d*)(m|h|d)$/i.exec(value || "");
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const duration = amount * multiplier;
  return duration <= MAX_TIMEOUT_MS ? duration : null;
}

async function handleModerationCommand(message, command, args) {
  if (command === "help") {
    await message.reply({
      content: [
        "أوامر الإدارة:",
        "`!warn @عضو [السبب]` (Manage Messages)",
        "`!timeout @عضو 10m|2h|1d [السبب]` (Moderate Members)",
        "`!kick @عضو [السبب]` (Kick Members)",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    return;
  }

  const requiredPermission = {
    warn: PermissionFlagsBits.ManageMessages,
    timeout: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
  }[command];

  if (!requiredPermission || !message.member.permissions.has(requiredPermission)) {
    await message.reply({
      content: "ليس لديك صلاحية استخدام هذا الأمر.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  const memberArgument = args.shift();
  const target = message.mentions.members.first();
  if (!memberArgument || !/^<@!?\d+>$/.test(memberArgument) || !target) {
    await message.reply({
      content: "اذكر العضو أولًا. استخدم `!help` لمعرفة الصيغة.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (target.id === message.author.id || target.id === message.guild.ownerId) {
    await message.reply({
      content: "لا يمكن تنفيذ هذا الإجراء على هذا العضو.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  const botMember = message.guild.members.me;
  if (!botMember) throw new Error("The bot's guild member is not available.");

  if (
    command !== "warn"
    && (
      target.roles.highest.comparePositionTo(message.member.roles.highest) >= 0
      || target.roles.highest.comparePositionTo(botMember.roles.highest) >= 0
    )
  ) {
    await message.reply({
      content: "لا يمكن تنفيذ هذا الإجراء بسبب ترتيب الرتب.",
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (command === "warn") {
    const reason = args.join(" ").trim() || "لم يُذكر سبب";
    await message.channel.send({
      content: `⚠️ ${target} تم تحذيره بواسطة ${message.author}. السبب: ${reason}`,
      allowedMentions: { users: [target.id] },
    });
    await writeAuditLog(
      message.guild,
      `تحذير: ${target.user.tag} بواسطة ${message.author.tag}. السبب: ${reason}`,
    );
    return;
  }

  if (command === "timeout") {
    const duration = parseTimeout(args.shift());
    if (!duration) {
      await message.reply({
        content: "المدة غير صحيحة. استخدم مثلًا `10m` أو `2h` أو `1d` (الحد الأقصى 28 يومًا).",
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply({
        content: "البوت يحتاج صلاحية Moderate Members.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const reason = args.join(" ").trim() || `بواسطة ${message.author.tag}`;
    await target.timeout(duration, reason);
    await message.reply({
      content: `تم كتم ${target} مؤقتًا. السبب: ${reason}`,
      allowedMentions: { users: [target.id] },
    });
    await writeAuditLog(
      message.guild,
      `كتم مؤقت: ${target.user.tag} بواسطة ${message.author.tag}. السبب: ${reason}`,
    );
    return;
  }

  if (command === "kick") {
    if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
      await message.reply({
        content: "البوت يحتاج صلاحية Kick Members.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const reason = args.join(" ").trim() || `بواسطة ${message.author.tag}`;
    await target.kick(reason);
    await message.reply({
      content: `تم طرد ${target.user.tag}. السبب: ${reason}`,
      allowedMentions: { parse: [] },
    });
    await writeAuditLog(
      message.guild,
      `طرد: ${target.user.tag} بواسطة ${message.author.tag}. السبب: ${reason}`,
    );
  }
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;

  const commandMatch = /^!(warn|timeout|kick|help)\b/i.exec(message.content.trim());
  if (commandMatch) {
    await handleModerationCommand(
      message,
      commandMatch[1].toLowerCase(),
      message.content.trim().slice(commandMatch[0].length).trim().split(/\s+/).filter(Boolean),
    );
    return;
  }

  if (isModerator(message.member)) return;

  if (recordMessage(message.guild.id, message.author.id)) {
    await message.delete();
    await warnInChannel(message, "تم حذف رسالتك بسبب إرسال رسائل كثيرة بسرعة.");
    return;
  }

  if (messageContainsBlockedLink(message.content)) {
    await message.delete();
    await warnInChannel(message, "الروابط غير مسموح بها في هذا السيرفر.");
  }
}

client.on("messageCreate", (message) => {
  void handleMessage(message).catch((error) => logError("messageCreate", error));
});

client.on("guildMemberAdd", (member) => {
  void writeAuditLog(
    member.guild,
    `مرحبا بك ${member}، انضممت إلى السيرفر.`,
    { users: [member.id] },
  )
    .catch((error) => logError("guildMemberAdd", error));
});

client.on("guildMemberRemove", (member) => {
  void writeAuditLog(member.guild, `غادر السيرفر: ${member.user.tag}.`)
    .catch((error) => logError("guildMemberRemove", error));
});

client.on("messageDelete", (message) => {
  if (!message.guild || message.author?.bot) return;
  const author = message.author?.tag || "عضو غير معروف";
  const content = message.content?.slice(0, 500) || "محتوى غير متاح";
  void writeAuditLog(message.guild, `حذف رسالة لـ ${author}: ${content}`)
    .catch((error) => logError("messageDelete", error));
});

client.on("messageUpdate", (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) return;
  const author = newMessage.author?.tag || "عضو غير معروف";
  const before = oldMessage.content?.slice(0, 400) || "محتوى غير متاح";
  const after = newMessage.content?.slice(0, 400) || "محتوى غير متاح";
  void writeAuditLog(
    newMessage.guild,
    `تعديل رسالة لـ ${author}. قبل: ${before} | بعد: ${after}`,
  ).catch((error) => logError("messageUpdate", error));
});

client.on("error", (error) => logError("client", error));

if (!process.env.DISCORD_TOKEN) {
  throw new Error("Set the DISCORD_TOKEN environment variable before starting the bot.");
}

client.login(process.env.DISCORD_TOKEN)
  .catch((error) => {
    logError("login", error);
    process.exitCode = 1;
  });