import {
  getContentType,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { StoreQueries, ContactRow, ChatRow, MessageRow } from "../store/queries.ts";
import type { ReactiveBridge } from "../ui/state.tsx";
import { log, warn } from "../utils/log.ts";

// ── Converters ──────────────────────────────────────────────────────

/** Convert protobuf Long / number / null to unix timestamp. Returns 0 for unknown — NEVER Date.now(). */
function toTimestamp(ts: unknown): number {
  if (ts == null) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts === "bigint") return Number(ts);
  if (typeof ts === "object" && ts !== null && "low" in ts)
    return ((ts as any).low as number) >>> 0;
  const n = Number(ts);
  return isNaN(n) ? 0 : n;
}

/** Like toTimestamp but falls back to Date.now() — only for messages where we MUST have a timestamp */
function toTimestampRequired(ts: unknown): number {
  const t = toTimestamp(ts);
  return t > 0 ? t : Math.floor(Date.now() / 1000);
}

function convertContact(c: any): ContactRow {
  return {
    jid: c.id,
    lid: c.lid ?? null,
    name: c.name ?? null,
    notify: c.notify ?? null,
    phone: c.phoneNumber ?? null,
  };
}

function convertChat(c: any): ChatRow {
  const ts = toTimestamp(c.conversationTimestamp);
  return {
    jid: c.id,
    name: c.name ?? c.subject ?? null,
    last_msg_ts: ts > 0 ? ts : null,  // null = don't overwrite existing timestamp
    unread: c.unreadCount ?? 0,
    pinned: c.pinned ? 1 : 0,
    archived: c.archived ? 1 : 0,
    muted_until: c.muteEndTime ? toTimestamp(c.muteEndTime) : 0,
    is_group: c.id?.endsWith?.("@g.us") ? 1 : 0,
    lid_jid: c.lidJid ?? c.accountLid ?? null,
  };
}

const MEDIA_TYPES = new Set([
  "imageMessage", "videoMessage", "audioMessage",
  "stickerMessage", "documentMessage",
]);

const SKIP_MESSAGE_TYPES = new Set([
  "protocolMessage", "senderKeyDistributionMessage",
]);

function convertMessage(msg: WAMessage): MessageRow | null {
  if (!msg?.key?.id || !msg.key.remoteJid) return null;

  const contentType = msg.message ? getContentType(msg.message) : null;
  const content = contentType ? (msg.message as any)?.[contentType] : null;
  const text =
    content?.text ??
    content?.caption ??
    content?.selectedDisplayText ??
    content?.body ??
    (contentType === "conversation" ? (msg.message as any)?.conversation : null) ??
    null;

  return {
    id: msg.key.id,
    chat_jid: msg.key.remoteJid,
    sender_jid: msg.key.participant ?? (msg.key.fromMe ? null : msg.key.remoteJid),
    from_me: msg.key.fromMe ? 1 : 0,
    timestamp: toTimestampRequired(msg.messageTimestamp),
    type: contentType ?? "unknown",
    text,
    media_type: contentType && MEDIA_TYPES.has(contentType) ? contentType : null,
    media_path: null,
    quoted_id: content?.contextInfo?.stanzaId ?? null,
    status: msg.status ?? 0,
    push_name: msg.pushName ?? null,
  };
}

// ── Handler registration ────────────────────────────────────────────

export function registerHandlers(sock: WASocket, store: StoreQueries, bridge?: ReactiveBridge) {
  // History sync — the big one
  sock.ev.on("messaging-history.set" as any, (data: any) => {
    const { chats, contacts, messages } = data;

    if (contacts?.length) {
      store.bulkUpsertContacts(contacts.map(convertContact));
    }

    // Extract messages from BOTH top-level messages array AND chat-embedded messages
    const allMsgRows: MessageRow[] = [];
    function tryConvertEntry(entry: any) {
      try {
        if (entry?.key?.id) {
          const row = convertMessage(entry);
          if (row) allMsgRows.push(row);
          return;
        }
        const msg = entry?.message ?? entry;
        if (!msg) return;
        const row = convertMessage(msg);
        if (row) allMsgRows.push(row);
      } catch (e) {
        warn("sync", `Failed to convert message: ${(e as Error)?.message}`);
      }
    }

    if (chats?.length) {
      store.bulkUpsertChats(chats.map(convertChat));

      for (const chat of chats) {
        if (!chat.messages?.length) continue;
        for (const entry of chat.messages) {
          tryConvertEntry(entry);
        }
      }
    }

    if (messages?.length) {
      for (const entry of messages) {
        tryConvertEntry(entry);
      }
    }

    if (allMsgRows.length) store.bulkInsertMessages(allMsgRows);

    log("sync", `${contacts?.length ?? 0}C ${chats?.length ?? 0}Ch ${allMsgRows.length}M`);

    bridge?.onHistoryBatch();
  });

  // Contacts — call bridge once per batch, not per item
  sock.ev.on("contacts.upsert", (newContacts) => {
    const rows = newContacts.map(convertContact);
    store.bulkUpsertContacts(rows);
    log("contacts", `+${newContacts.length} (total: ${store.countContacts()})`);
    if (rows.length > 0) bridge?.onContactUpdate(rows[0]!);
  });

  sock.ev.on("contacts.update", (updates) => {
    const rows = updates.map(convertContact);
    store.bulkUpsertContacts(rows);
    if (rows.length > 0) bridge?.onContactUpdate(rows[0]!);
  });

  // Chats — call bridge once per batch
  sock.ev.on("chats.upsert", (newChats) => {
    const rows = newChats.map(convertChat);
    store.bulkUpsertChats(rows);
    if (rows.length > 0) bridge?.onChatUpdate(rows[0]!);
  });

  sock.ev.on("chats.update", (updates) => {
    const rows = updates.map(convertChat);
    store.bulkUpsertChats(rows);
    if (rows.length > 0) bridge?.onChatUpdate(rows[0]!);
  });

  // Messages — real-time
  sock.ev.on("messages.upsert", ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const row = convertMessage(msg);
      if (!row) continue;

      if (SKIP_MESSAGE_TYPES.has(row.type)) continue;

      store.insertMessage(row);

      const chatJid = msg.key.remoteJid;
      if (chatJid) {
        store.upsertChat({
          jid: chatJid,
          last_msg_ts: row.timestamp,
          is_group: chatJid.endsWith("@g.us") ? 1 : 0,
        });
        // onNewMessage already calls refreshChats, no need for separate onChatUpdate
        bridge?.onNewMessage(row, chatJid);
      }

      const name = msg.pushName ? ` (${msg.pushName})` : "";
      const textPreview = row.text ? `: ${row.text.slice(0, 60)}` : "";
      log("msg", `${row.type} from ${row.sender_jid ?? "me"}${name}${textPreview}`);
    }
  });

  // Message status updates (delivery receipts)
  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (key.id && update.status != null) {
        store.updateMessageStatus(key.id, update.status);
        bridge?.onStatusUpdate(key.id, update.status);
      }
    }
  });

  // Presence (typing indicators)
  sock.ev.on("presence.update", (json) => {
    const { id, presences } = json;
    if (!id || !presences || !bridge) return;
    const isTyping = Object.values(presences).some(
      (p: any) => p.lastKnownPresence === "composing"
    );
    bridge.onPresenceUpdate(id, isTyping);
  });

  // Groups
  sock.ev.on("groups.upsert", (groups) => {
    for (const g of groups) {
      store.upsertChat({
        jid: g.id,
        name: g.subject ?? null,
        is_group: 1,
      });
      if (g.participants?.length) {
        store.upsertGroupParticipants(
          g.id,
          g.participants.map((p) => ({
            group_jid: g.id,
            user_jid: p.id,
            role: p.admin ?? null,
          }))
        );
      }
    }
  });

  sock.ev.on("group-participants.update", (event) => {
    const { id: groupJid, participants, action } = event;
    if (action === "remove") {
      store.removeGroupParticipants(groupJid, participants);
    } else {
      store.upsertGroupParticipants(
        groupJid,
        participants.map((p) => ({
          group_jid: groupJid,
          user_jid: p,
          role: action === "promote" ? "admin" : null,
        }))
      );
    }
  });
}
