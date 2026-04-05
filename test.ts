/**
 * Baileys Test Harness
 * Tests: QR auth, session persistence, contacts, LID, groups, message types, send/receive, media
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  getContentType,
  Browsers,
  type WASocket,
  type BaileysEventMap,
  type WAMessageKey,
  type WAMessageContent,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { createInterface } from "readline";

// ── Config ──────────────────────────────────────────────────────────

const AUTH_DIR = "./auth_state";
const MEDIA_DIR = "./downloads";
const LOG_LEVEL = "silent"; // change to "debug" for baileys internals

// ── State ───────────────────────────────────────────────────────────

let sock: WASocket;
let messageLog: Array<{
  from: string;
  type: string;
  text?: string;
  timestamp: number;
}> = [];

// Contacts store: maps JID/LID → display name
const contacts = new Map<string, { name?: string; notify?: string; lid?: string }>();

// Chat list: maps JID → chat info with ordering
const chats = new Map<
  string,
  { id: string; name?: string; conversationTimestamp?: number; unreadCount?: number }
>();

// ── Helpers ─────────────────────────────────────────────────────────

const log = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[36m[${tag}]\x1b[0m`, ...args);

const warn = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[33m[${tag}]\x1b[0m`, ...args);

const ok = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[32m[${tag}]\x1b[0m`, ...args);

const err = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[31m[${tag}]\x1b[0m`, ...args);

function resolveName(jid: string): string {
  const contact = contacts.get(jid);
  if (contact?.name) return contact.name;
  if (contact?.notify) return contact.notify;
  // Try LID lookup
  for (const [, c] of contacts) {
    if (c.lid && jid.startsWith(c.lid.split("@")[0])) {
      return c.name || c.notify || jid.split("@")[0];
    }
  }
  return jid.split("@")[0];
}

function getMessageType(
  msg: BaileysEventMap["messages.upsert"]["messages"][0]
): string {
  if (!msg.message) return "empty";
  const type = getContentType(msg.message);
  return type || "unknown";
}

function getMessageText(
  msg: BaileysEventMap["messages.upsert"]["messages"][0]
): string | undefined {
  if (!msg.message) return undefined;
  const type = getContentType(msg.message);
  if (!type) return undefined;
  const content = (msg.message as any)[type];
  return (
    content?.text ||
    content?.caption ||
    content?.selectedDisplayText ||
    content?.body ||
    undefined
  );
}

// ── REPL Commands ───────────────────────────────────────────────────

function printHelp() {
  console.log(`
\x1b[1mBaileys Test Harness — Commands\x1b[0m

  \x1b[36mchats\x1b[0m              List chats ordered by last message
  \x1b[36mcontacts\x1b[0m           List synced contacts with names
  \x1b[36mgroups\x1b[0m             List all groups with member count
  \x1b[36mgroup <jid>\x1b[0m        Show group metadata + participants
  \x1b[36msend <jid> <text>\x1b[0m  Send a text message
  \x1b[36mlog\x1b[0m                Show received messages log
  \x1b[36mclear\x1b[0m              Clear message log
  \x1b[36mme\x1b[0m                 Show own JID info
  \x1b[36mstatus\x1b[0m             Connection status
  \x1b[36mquit\x1b[0m               Disconnect and exit
  \x1b[36mhelp\x1b[0m               Show this help
`);
}

async function handleCommand(input: string) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "help":
    case "h":
      printHelp();
      break;

    case "me": {
      const me = sock.user;
      if (me) {
        ok("me", `JID: ${me.id}`);
        ok("me", `Name: ${me.name || "(none)"}`);
        ok("me", `LID: ${me.lid || "(none)"}`);
      } else {
        warn("me", "Not connected yet");
      }
      break;
    }

    case "chats": {
      if (chats.size === 0) {
        warn("chats", "No chats received yet — wait for sync to complete");
        break;
      }
      const sorted = [...chats.values()].sort(
        (a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0)
      );
      log("chats", `${sorted.length} chats (ordered by last message):`);
      for (const c of sorted.slice(0, 40)) {
        const name = c.name || resolveName(c.id);
        const time = c.conversationTimestamp
          ? new Date(c.conversationTimestamp * 1000).toLocaleString()
          : "?";
        const unread = c.unreadCount ? ` (${c.unreadCount} unread)` : "";
        console.log(`  ${name}${unread} — ${time} — ${c.id}`);
      }
      if (sorted.length > 40)
        console.log(`  ... and ${sorted.length - 40} more`);
      break;
    }

    case "contacts": {
      if (contacts.size === 0) {
        warn("contacts", "No contacts received yet");
        break;
      }
      log("contacts", `${contacts.size} contacts:`);
      const sorted = [...contacts.entries()].sort((a, b) =>
        (a[1].name || a[1].notify || "").localeCompare(b[1].name || b[1].notify || "")
      );
      for (const [jid, c] of sorted.slice(0, 40)) {
        const lid = c.lid ? ` (LID: ${c.lid})` : "";
        console.log(`  ${c.name || c.notify || "(no name)"} — ${jid}${lid}`);
      }
      if (sorted.length > 40)
        console.log(`  ... and ${sorted.length - 40} more`);
      break;
    }

    case "groups": {
      const groups = await sock.groupFetchAllParticipating();
      const sorted = Object.values(groups).sort(
        (a, b) => (b.participants?.length || 0) - (a.participants?.length || 0)
      );
      log("groups", `Total: ${sorted.length} groups`);
      for (const g of sorted) {
        console.log(
          `  [${g.participants.length}] ${g.subject || "(unnamed)"} — ${g.id}`
        );
      }
      break;
    }

    case "group": {
      const jid = parts[1];
      if (!jid) {
        warn("group", "Usage: group <jid>");
        break;
      }
      try {
        const meta = await sock.groupMetadata(jid);
        ok("group", `Name: ${meta.subject}`);
        ok("group", `ID: ${meta.id}`);
        ok("group", `Description: ${meta.desc || "(none)"}`);
        ok("group", `Created by: ${meta.owner || "unknown"}`);
        ok("group", `Participants (${meta.participants.length}):`);
        for (const p of meta.participants) {
          const role = p.admin ? ` [${p.admin}]` : "";
          const name = resolveName(p.id);
          const nameLabel = name !== p.id.split("@")[0] ? ` — ${name}` : "";
          console.log(`    ${p.id}${role}${nameLabel}`);
        }
      } catch (e: any) {
        err("group", `Failed: ${e.message}`);
      }
      break;
    }

    case "send": {
      const jid = parts[1];
      const text = parts.slice(2).join(" ");
      if (!jid || !text) {
        warn("send", "Usage: send <jid> <text>");
        break;
      }
      try {
        const result = await sock.sendMessage(jid, { text });
        ok(
          "send",
          `Sent to ${jid} — status: ${result?.status}, id: ${result?.key?.id?.slice(0, 12)}...`
        );
      } catch (e: any) {
        err("send", `Failed: ${e.message}`);
      }
      break;
    }

    case "log": {
      if (messageLog.length === 0) {
        log("log", "No messages received yet. Send yourself a message!");
      } else {
        log("log", `${messageLog.length} messages received:`);
        for (const m of messageLog.slice(-30)) {
          const time = new Date(m.timestamp * 1000).toLocaleTimeString();
          const text = m.text ? ` — "${m.text.slice(0, 60)}"` : "";
          console.log(`  [${time}] ${m.from} (${m.type})${text}`);
        }
      }
      break;
    }

    case "clear":
      messageLog = [];
      ok("clear", "Message log cleared");
      break;

    case "status": {
      const me = sock.user;
      ok(
        "status",
        me ? `Connected as ${me.id} (${me.name})` : "Not connected"
      );
      ok("status", `Messages received this session: ${messageLog.length}`);
      break;
    }

    case "quit":
    case "q":
    case "exit":
      log("quit", "Disconnecting...");
      sock.end(undefined);
      process.exit(0);

    default:
      if (cmd) warn("repl", `Unknown command: ${cmd}. Type 'help' for usage.`);
  }
}

// ── Connection ──────────────────────────────────────────────────────

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const logger = pino({ level: LOG_LEVEL }) as any;

  const { version, isLatest } = await fetchLatestBaileysVersion();
  log("init", `WA Web version: ${version.join(".")} (latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: Browsers.macOS("Desktop"),
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    getMessage: async (key: WAMessageKey): Promise<WAMessageContent | undefined> => {
      return undefined;
    },
  });

  // ── Connection events ─────────────────────────────────────────

  let reconnectAttempt = 0;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log("auth", "Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect && reconnectAttempt < 5) {
        reconnectAttempt++;
        const delay = Math.min(reconnectAttempt * 3000, 15000);
        warn("conn", `Disconnected (${statusCode}), reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempt}/5)`);
        await new Promise((r) => setTimeout(r, delay));
        connect();
      } else if (!shouldReconnect) {
        err("conn", "Logged out. Delete auth_state/ and restart to re-auth.");
      } else {
        err("conn", `Max reconnection attempts reached. Last error: ${statusCode}`);
        process.exit(1);
      }
    } else if (connection === "open") {
      reconnectAttempt = 0;
      ok("conn", "Connected to WhatsApp!");
      const me = sock.user;
      if (me) {
        ok("conn", `JID: ${me.id}`);
        ok("conn", `Name: ${me.name || "(none)"}`);
        ok("conn", `LID: ${me.lid || "(none)"}`);
      }
      console.log("");
      printHelp();
      startRepl();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Debug: log ALL event names ────────────────────────────────
  const originalEmit = sock.ev.emit.bind(sock.ev);
  sock.ev.emit = ((event: string, ...args: any[]) => {
    if (event !== "messages.upsert" && event !== "creds.update" && event !== "messages.update") {
      const dataSize = args[0] ? (Array.isArray(args[0]) ? args[0].length : "obj") : "?";
      warn("event", `${event} (${dataSize})`);
      // Dump first item for key events
      if ((event === "chats.upsert" || event === "contacts.upsert" || event === "messaging-history.set") && args[0]) {
        const sample = Array.isArray(args[0]) ? args[0][0] : args[0];
        warn("event.sample", JSON.stringify(sample, null, 2)?.slice(0, 500));
      }
    }
    return originalEmit(event, ...args);
  }) as any;

  // ── Message events ────────────────────────────────────────────

  sock.ev.on("messages.upsert", async ({ messages, type: upsertType }) => {
    for (const msg of messages) {
      const msgType = getMessageType(msg);
      const text = getMessageText(msg);
      const from = msg.key.remoteJid || "unknown";
      const sender = msg.key.participant || from;
      const isGroup = from.endsWith("@g.us");
      const pushName = msg.pushName || "";
      const timestamp =
        typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

      messageLog.push({ from: sender, type: msgType, text, timestamp });

      // Pretty print incoming message
      const time = new Date(timestamp * 1000).toLocaleTimeString();
      const fromLabel = isGroup ? `${from} / ${sender}` : from;
      const nameLabel = pushName ? ` (${pushName})` : "";
      const textLabel = text ? `: ${text.slice(0, 80)}` : "";

      log("msg", `[${time}] ${fromLabel}${nameLabel}`);
      log("msg", `  type=${msgType} | upsert=${upsertType}${textLabel}`);

      // Auto-download media for testing
      if (
        msgType === "imageMessage" ||
        msgType === "videoMessage" ||
        msgType === "audioMessage" ||
        msgType === "stickerMessage" ||
        msgType === "documentMessage"
      ) {
        try {
          if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
          const ext =
            msgType === "imageMessage"
              ? "jpg"
              : msgType === "videoMessage"
                ? "mp4"
                : msgType === "audioMessage"
                  ? "ogg"
                  : msgType === "stickerMessage"
                    ? "webp"
                    : "bin";
          const filename = `${MEDIA_DIR}/${Date.now()}.${ext}`;
          writeFileSync(filename, buffer);
          ok("media", `Downloaded ${msgType} → ${filename} (${buffer.length} bytes)`);
        } catch (e: any) {
          warn("media", `Download failed: ${e.message}`);
        }
      }

      // Log reaction details
      if (msgType === "reactionMessage") {
        const reaction = (msg.message as any)?.reactionMessage;
        if (reaction) {
          log(
            "reaction",
            `${reaction.text || "(removed)"} on ${reaction.key?.id?.slice(0, 12)}`
          );
        }
      }
    }
  });

  // ── Contact events ────────────────────────────────────────────

  sock.ev.on("contacts.upsert", (newContacts) => {
    for (const c of newContacts) {
      contacts.set(c.id, {
        name: (c as any).name || contacts.get(c.id)?.name,
        notify: (c as any).notify || contacts.get(c.id)?.notify,
        lid: (c as any).lid || contacts.get(c.id)?.lid,
      });
    }
    log("contacts", `Synced ${newContacts.length} contacts (total: ${contacts.size})`);
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      const existing = contacts.get(u.id) || {};
      contacts.set(u.id, {
        name: (u as any).name || existing.name,
        notify: (u as any).notify || existing.notify,
        lid: (u as any).lid || existing.lid,
      });
    }
    log("contacts.update", `Updated ${updates.length} contacts (total: ${contacts.size})`);
  });

  // ── Chat events ───────────────────────────────────────────────

  sock.ev.on("chats.upsert", (newChats) => {
    for (const c of newChats) {
      chats.set(c.id, {
        id: c.id,
        name: (c as any).name || chats.get(c.id)?.name,
        conversationTimestamp: Number((c as any).conversationTimestamp) || chats.get(c.id)?.conversationTimestamp,
        unreadCount: (c as any).unreadCount ?? chats.get(c.id)?.unreadCount,
      });
    }
    log("chats", `Synced ${newChats.length} chats (total: ${chats.size})`);
  });

  sock.ev.on("chats.update", (updates) => {
    for (const u of updates) {
      const existing = chats.get(u.id) || { id: u.id };
      chats.set(u.id, {
        ...existing,
        name: (u as any).name || existing.name,
        conversationTimestamp: Number((u as any).conversationTimestamp) || existing.conversationTimestamp,
        unreadCount: (u as any).unreadCount ?? existing.unreadCount,
      });
    }
  });

  // ── History sync (main data source) ────────────────────────────

  sock.ev.on("messaging-history.set" as any, (data: any) => {
    const { chats: syncedChats, contacts: syncedContacts, messages: syncedMessages } = data;

    if (syncedContacts?.length) {
      for (const c of syncedContacts) {
        contacts.set(c.id, {
          name: c.name || contacts.get(c.id)?.name,
          notify: c.notify || contacts.get(c.id)?.notify,
          lid: c.lid || contacts.get(c.id)?.lid,
        });
      }
      log("history", `Synced ${syncedContacts.length} contacts (total: ${contacts.size})`);
    }

    if (syncedChats?.length) {
      for (const c of syncedChats) {
        const ts = c.conversationTimestamp
          ? (typeof c.conversationTimestamp === "object"
              ? Number(c.conversationTimestamp.low || c.conversationTimestamp)
              : Number(c.conversationTimestamp))
          : chats.get(c.id)?.conversationTimestamp;
        chats.set(c.id, {
          id: c.id,
          name: c.name || chats.get(c.id)?.name,
          conversationTimestamp: ts,
          unreadCount: c.unreadCount ?? chats.get(c.id)?.unreadCount,
        });
      }
      log("history", `Synced ${syncedChats.length} chats (total: ${chats.size})`);
    }

    if (syncedMessages?.length) {
      log("history", `Synced ${syncedMessages.length} message batches`);
    }
  });

  // ── Group events ──────────────────────────────────────────────

  sock.ev.on("groups.upsert", (groups) => {
    log("groups.upsert", `${groups.length} groups:`);
    for (const g of groups) {
      console.log(`  ${g.subject || "(unnamed)"} — ${g.id}`);
    }
  });

  sock.ev.on("group-participants.update", (event) => {
    log(
      "group-participants",
      `${event.action}: ${event.participants.join(", ")} in ${event.id}`
    );
  });

  // ── Message update (status/receipts) ──────────────────────────

  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      if (u.update.status) {
        const statusMap: Record<number, string> = {
          1: "pending",
          2: "server",
          3: "delivered",
          4: "read",
          5: "played",
        };
        const statusName = statusMap[u.update.status] || `${u.update.status}`;
        log(
          "status",
          `${u.key.id?.slice(0, 12)} → ${statusName} (${u.key.remoteJid})`
        );
      }
    }
  });
}

// ── REPL ────────────────────────────────────────────────────────────

function startRepl() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[35mbaileys>\x1b[0m ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    await handleCommand(line);
    rl.prompt();
  });

  rl.on("close", () => {
    log("quit", "Bye!");
    process.exit(0);
  });
}

// ── Main ────────────────────────────────────────────────────────────

log("init", "Baileys Test Harness v1.0");
log("init", `Auth dir: ${AUTH_DIR}`);
log("init", existsSync(AUTH_DIR) ? "Session found — resuming" : "No session — QR auth required");
log("init", "Connecting...");
console.log("");

connect();
