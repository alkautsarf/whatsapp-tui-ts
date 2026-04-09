import {
  getContentType,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import type { StoreQueries, ContactRow, ChatRow, MessageRow } from "../store/queries.ts";
import type { ReactiveBridge } from "../ui/state.tsx";
import { log, warn } from "../utils/log.ts";
import { notify } from "../utils/notify.ts";
import { isTerminalFocused } from "../utils/terminal-focus.ts";
import { cacheRawMessage } from "./media.ts";
import { MEDIA_TYPES, SKIP_MESSAGE_TYPES, mediaLabel } from "./message-types.ts";

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

function convertMessage(msg: WAMessage): MessageRow | null {
  if (!msg?.key?.id || !msg.key.remoteJid) return null;

  const contentType = msg.message ? getContentType(msg.message) : null;
  // No identifiable content type → can't display (e.g. encrypted messages for
  // groups we've left where we no longer have the sender key). Skip entirely
  // to prevent ghost group rows from being created/bumped via upsertChat.
  if (!contentType) return null;
  const content = (msg.message as any)?.[contentType] ?? null;
  const text =
    content?.text ??
    content?.caption ??
    content?.selectedDisplayText ??
    content?.body ??
    (contentType === "conversation" ? (msg.message as any)?.conversation : null) ??
    null;

  const isMedia = contentType && MEDIA_TYPES.has(contentType);

  return {
    id: msg.key.id,
    chat_jid: msg.key.remoteJid,
    sender_jid: msg.key.participant ?? (msg.key.fromMe ? null : msg.key.remoteJid),
    from_me: msg.key.fromMe ? 1 : 0,
    timestamp: toTimestampRequired(msg.messageTimestamp),
    type: contentType ?? "unknown",
    text,
    media_type: isMedia ? contentType : null,
    media_path: null,
    media_key: isMedia && content?.mediaKey ? Buffer.from(content.mediaKey).toString("base64") : null,
    direct_path: isMedia ? (content?.directPath ?? null) : null,
    media_url: isMedia ? (content?.url ?? null) : null,
    mimetype: isMedia ? (content?.mimetype ?? null) : null,
    file_name: content?.fileName ?? null,
    file_size: content?.fileLength ? Number(content.fileLength) : null,
    width: content?.width ?? null,
    height: content?.height ?? null,
    thumbnail: content?.jpegThumbnail ? Buffer.from(content.jpegThumbnail).toString("base64")
             : content?.pngThumbnail ? Buffer.from(content.pngThumbnail).toString("base64")
             : null,
    quoted_id: content?.contextInfo?.stanzaId ?? null,
    status: msg.status ?? 0,
    push_name: msg.pushName ?? null,
  };
}

// ── Handler registration ────────────────────────────────────────────

/** Resolve a JID to phone format if it's a LID JID */
function resolveJid(jid: string, store: StoreQueries): string {
  if (jid.endsWith("@lid")) return store.resolveLidToPhoneJid(jid);
  return jid;
}

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
          if (entry.message) cacheRawMessage(entry);
          const row = convertMessage(entry);
          if (row) allMsgRows.push(row);
          return;
        }
        const msg = entry?.message ?? entry;
        if (!msg) return;
        if (msg.message && msg.key?.id) cacheRawMessage(msg);
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

    // Resolve LID → phone JID for all messages before inserting
    for (const row of allMsgRows) {
      if (row.chat_jid.endsWith("@lid")) {
        row.chat_jid = resolveJid(row.chat_jid, store);
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
    const rows = newChats.map((c) => {
      const row = convertChat(c);
      // Normalize LID-keyed chat updates to the canonical phone-jid row.
      // baileys post-sync pushes chat updates keyed by `<id>@lid` for known
      // contacts as part of WhatsApp's LID privacy rollout. Without this
      // line we'd create phantom duplicate rows that show up as a separate
      // entry in the chat list, alongside the real phone-jid row. Mirrors
      // what messages.upsert already does.
      row.jid = resolveJid(row.jid, store);
      return row;
    });
    store.bulkUpsertChats(rows);
    if (rows.length > 0) bridge?.onChatUpdate(rows[0]!);
  });

  sock.ev.on("chats.update", (updates) => {
    const rows = updates.map((c) => {
      const row = convertChat(c);
      row.jid = resolveJid(row.jid, store);
      return row;
    });
    // Unread double-count fix: WA's chats.update unreadCount already includes
    // the message that's about to arrive via messages.upsert, then state.tsx
    // onNewMessage adds +1 on top, giving us 2× for every incoming message.
    // Trust the local state.tsx counter as the source of truth for new
    // messages. Special case: if WA explicitly reports unreadCount === 0,
    // that means the user marked-as-read on another device — propagate the
    // clear locally too so cross-device read sync still works.
    for (let i = 0; i < rows.length; i++) {
      const explicitlyZero = (updates[i] as any).unreadCount === 0;
      if (explicitlyZero) {
        store.clearUnread(rows[i]!.jid);
      }
      // Setting to 0 makes upsertChat preserve existing (the SQL CASE WHEN
      // excluded.unread > 0 falls through to chats.unread when the value is 0).
      rows[i]!.unread = 0;
    }
    store.bulkUpsertChats(rows);
    if (rows.length > 0) bridge?.onChatUpdate(rows[0]!);
  });

  // Messages — real-time
  sock.ev.on("messages.upsert", ({ messages: msgs, type }) => {
    // Collect read-receipt keys for messages in the chat the user is currently
    // viewing — sent in one batched call after the loop. Without this WA keeps
    // pushing chats.update with unreadCount>0 and the badge ghosts back.
    const readKeys: WAMessageKey[] = [];
    const viewingJid = bridge?.getViewJid?.() ?? null;
    // Only fire system notifications for "notify" upserts (real new messages
    // arriving), never for "append" / history sync replays.
    const allowNotifications = type === "notify";
    const nowSeconds = Math.floor(Date.now() / 1000);

    for (const msg of msgs) {
      if (msg.message && msg.key?.id) cacheRawMessage(msg);

      const row = convertMessage(msg);
      if (!row) continue;

      if (SKIP_MESSAGE_TYPES.has(row.type)) continue;

      const rawChatJid = msg.key.remoteJid;
      if (rawChatJid) {
        const chatJid = resolveJid(rawChatJid, store);
        row.chat_jid = chatJid;
        store.insertMessage(row);
        store.upsertChat({
          jid: chatJid,
          last_msg_ts: row.timestamp,
          is_group: chatJid.endsWith("@g.us") ? 1 : 0,
        });
        bridge?.onNewMessage(row, chatJid);

        if (row.from_me === 0 && viewingJid === chatJid) {
          readKeys.push({
            remoteJid: chatJid,
            id: row.id,
            participant: chatJid.endsWith("@g.us")
              ? (row.sender_jid ?? undefined)
              : undefined,
          });
        }

        // System notification gate — fires only when ALL conditions hold:
        //   1. type === "notify"            (real new message, not history sync)
        //   2. !from_me                     (not sent by us)
        //   3. NOT (chat is selected AND wa-tui terminal is focused)
        //                                   (suppress only when user is actually
        //                                    looking at the chat — a chat being
        //                                    selected in a background tmux session
        //                                    should still notify)
        //   4. chat is not status@broadcast (status updates are noise)
        //   5. chat is not muted on WA      (respect user's mute preference)
        //   6. per-chat rate limit (3s)     (handled inside notify())
        const userActivelyViewing =
          viewingJid === chatJid && isTerminalFocused();
        if (
          allowNotifications &&
          row.from_me === 0 &&
          !userActivelyViewing &&
          chatJid !== "status@broadcast"
        ) {
          const chatRow = store.getChat(chatJid);
          const muted = chatRow?.muted_until
            ? chatRow.muted_until === -1 || chatRow.muted_until > nowSeconds
            : false;
          if (!muted) {
            const isGroup = chatJid.endsWith("@g.us");
            const chatName = chatRow?.name ?? store.resolveContactName(chatJid);
            const messageText = row.text ?? mediaLabel(row.type) ?? "[message]";
            // Group sender name: prefer the user's address book name (via
            // contacts table) over WhatsApp's pushName. The participant JID
            // for group messages lives at msg.key.participant; for DMs it's
            // undefined and we never enter this branch anyway.
            //
            // Truncate to keep the message text visible in macOS notifications
            // — a long sender name can otherwise push the body off-screen.
            let senderName: string | null = null;
            if (isGroup) {
              const participantJid = msg.key.participant;
              if (participantJid) {
                const resolved = store.resolveContactName(participantJid);
                senderName = (resolved && resolved !== participantJid.split("@")[0])
                  ? resolved
                  : (msg.pushName ?? resolved);
              } else {
                senderName = msg.pushName ?? null;
              }
              if (senderName && senderName.length > 20) {
                senderName = senderName.slice(0, 19) + "\u2026";
              }
            }
            const body = isGroup && senderName
              ? `${senderName}: ${messageText}`
              : messageText;
            notify({
              title: chatName,
              body,
              chatJid,
              messageId: row.id,
            });
          }
        }
      } else {
        store.insertMessage(row);
      }

      const name = msg.pushName ? ` (${msg.pushName})` : "";
      const textPreview = row.text ? `: ${row.text.slice(0, 60)}` : "";
      log("msg", `${row.type} from ${row.sender_jid ?? "me"}${name}${textPreview}`);
    }

    if (readKeys.length > 0) {
      sock.readMessages(readKeys).catch(() => {});
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

  // Presence (typing + online status). After v0.4.10's LID dedup, all chats
  // are stored under canonical phone JIDs. Baileys may deliver presence
  // updates keyed by LID for contacts WhatsApp has rolled into the privacy
  // system — without resolveJid() the presence lands under the LID key but
  // the UI looks up by phone jid, so the typing/online indicator never
  // shows. Mirror what messages.upsert and chats.upsert/update already do.
  sock.ev.on("presence.update", (json) => {
    const { id, presences } = json;
    if (!id || !presences || !bridge) return;
    const canonicalJid = resolveJid(id, store);
    const entries = Object.values(presences) as any[];
    const isTyping = entries.some((p) => p.lastKnownPresence === "composing");
    // For DMs, use the single participant's presence; for groups, prefer "composing" > "available"
    const presence = entries[0]?.lastKnownPresence as string | undefined;
    bridge.onPresenceUpdate(canonicalJid, isTyping, presence);
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
    // baileys' participants field is technically GroupParticipant[] (objects
    // with .id) but in practice for the update event it can be string[]. Be
    // defensive: extract the id either way.
    const participantIds: string[] = (participants as any[]).map((p) =>
      typeof p === "string" ? p : p?.id ?? "",
    ).filter(Boolean);

    if (action === "remove") {
      // If the user themselves was removed from this group, prune the chat
      // row + all messages so it doesn't linger as a ghost. Otherwise we'd
      // accumulate stale group entries forever every time we leave or get
      // kicked from a group. Compare against both phone JID (with the device
      // suffix stripped) and LID forms of our identity.
      const me = sock.user?.id;
      const myLid = (sock.user as any)?.lid as string | undefined;
      const myPhone = me ? me.split(":")[0] + "@s.whatsapp.net" : null;
      const myLidBase = myLid ? myLid.split(":")[0] + "@lid" : null;

      const removedSelf = participantIds.some((p) => {
        if (!p) return false;
        if (p === me) return true;
        if (myPhone && p === myPhone) return true;
        if (myLid && p === myLid) return true;
        if (myLidBase && p === myLidBase) return true;
        return false;
      });

      if (removedSelf) {
        log("groups", `Pruning chat row for ${groupJid} — self removed`);
        store.deleteChat(groupJid);
        bridge?.onChatUpdate({ jid: groupJid } as ChatRow);
      } else {
        store.removeGroupParticipants(groupJid, participantIds);
      }
    } else {
      store.upsertGroupParticipants(
        groupJid,
        participantIds.map((p) => ({
          group_jid: groupJid,
          user_jid: p,
          role: action === "promote" ? "admin" : null,
        }))
      );
    }
  });
}
