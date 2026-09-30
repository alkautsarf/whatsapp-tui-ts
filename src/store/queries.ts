import type { Database } from "bun:sqlite";
import type { DbInstances } from "./db.ts";
import { MASK_BULLETS, MASK_CHARS } from "../utils/text.ts";

// ── Row types ───────────────────────────────────────────────────────

export interface ContactRow {
  jid: string;
  lid?: string | null;
  name?: string | null;
  notify?: string | null;
  phone?: string | null;
}

export interface ChatRow {
  jid: string;
  name?: string | null;
  last_msg_ts?: number | null;
  unread?: number;
  /** pinned / archived: 1 or 0. As with muted_until, undefined on a write
   *  means "no information" and keeps the stored value. */
  pinned?: number;
  archived?: number;
  /** 0 = not muted, -1 = muted always, >0 = muted until (unix seconds).
   *  On a write, leaving it undefined means "no information": the stored
   *  value is kept. See utils/mute.ts. */
  muted_until?: number;
  is_group?: number;
  lid_jid?: string | null;
  last_msg_text?: string | null;
  last_msg_type?: string | null;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid?: string | null;
  from_me: number;
  timestamp: number;
  type: string;
  text?: string | null;
  media_type?: string | null;
  media_path?: string | null;
  media_key?: string | null;
  direct_path?: string | null;
  media_url?: string | null;
  mimetype?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnail?: string | null;
  quoted_id?: string | null;
  status: number;
  push_name?: string | null;
  react_emoji?: string | null;
}

export interface GroupParticipantRow {
  group_jid: string;
  user_jid: string;
  role?: string | null;
}

export interface StoreQueries {
  // Write
  upsertContact(c: ContactRow): void;
  upsertChat(c: ChatRow): void;
  insertMessage(m: MessageRow): void;
  updateMessageStatus(id: string, status: number): void;
  updateMediaPath(id: string, path: string): void;
  clearUnread(jid: string): void;
  incrementUnread(jid: string): void;
  /** Overwrite a chat's mute state (stored form, see utils/mute.ts). */
  setChatMute(jid: string, mutedUntil: number): void;
  /** Small key/value store for one-shot flags (e.g. completed backfills). */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  upsertGroupParticipants(groupJid: string, participants: GroupParticipantRow[]): void;
  removeGroupParticipants(groupJid: string, userJids: string[]): void;
  bulkUpsertContacts(contacts: ContactRow[]): void;
  bulkUpsertChats(chats: ChatRow[]): void;
  bulkInsertMessages(messages: MessageRow[]): void;
  /** Delete a chat row + all its messages + group participants. Used when
   * the user is removed from a group, or for ghost-chat cleanup. */
  deleteChat(jid: string): void;
  /** Mark a message as locally deleted — clears text/media but keeps the
   * row so the bubble shows "[deleted]" in the conversation. */
  markMessageDeleted(id: string): void;
  /** Set the local reaction emoji on a message. Empty string clears it. */
  setReaction(id: string, emoji: string): void;

  // Read
  listChats(limit?: number): ChatRow[];
  getChat(jid: string): ChatRow | null;
  getMessages(chatJid: string, limit?: number, beforeTs?: number): MessageRow[];
  searchMessages(chatJid: string, query: string, limit?: number): MessageRow[];
  getMessage(id: string): MessageRow | null;
  getMessageContent(id: string): { text: string | null; type: string } | null;
  getContact(jid: string): ContactRow | null;
  resolveContactName(jid: string): string;
  searchContacts(query: string): ContactRow[];
  getGroupParticipants(groupJid: string): GroupParticipantRow[];
  resolveLidToPhoneJid(lidJid: string): string;
  countContacts(): number;
  countChats(): number;
  countMessages(): number;
}

// ── Masked names ────────────────────────────────────────────────────

/**
 * SQL predicate: is this column a privacy-masked phone number such as
 * "+62∙∙∙∙∙∙∙∙∙59" (U+2219 BULLET OPERATOR, or U+2022 BULLET)? It requires
 * the mask SHAPE, only digits, bullets and phone punctuation, not merely a
 * bullet: a saved name like "Mom • Work" is a real name. Built from the same
 * character class as isMaskedName() in utils/text.ts so the two cannot drift.
 */
function maskedNameSql(col: string): string {
  const hasBullet = MASK_BULLETS.map((b) => `${col} LIKE '%${b}%'`).join(" OR ");
  return `((${hasBullet}) AND ${col} NOT GLOB '*[^${MASK_CHARS}]*')`;
}

// ── Init ────────────────────────────────────────────────────────────

export function initQueries(db: DbInstances): StoreQueries {
  const { writer, reader } = db;

  // ── Write statements ──────────────────────────────────────────

  const upsertContactStmt = writer.prepare(`
    INSERT INTO contacts (jid, lid, name, notify, phone)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(jid) DO UPDATE SET
      lid    = COALESCE(excluded.lid, contacts.lid),
      -- A privacy-masked number ("+62∙∙∙∙∙∙∙∙∙59") must NEVER overwrite a real
      -- saved name. It is non-null, so a plain COALESCE(excluded.name, ...)
      -- happily clobbers the address-book name we already had. That is exactly
      -- what destroyed elpabl0's saved contact names during the 2026-08-14
      -- re-link resync: WhatsApp re-sent masks for privacy-restricted contacts
      -- and every one silently replaced a good name. Accept an incoming name
      -- only when it is not a mask, OR when we have nothing better stored.
      name   = CASE
                 WHEN excluded.name IS NULL OR excluded.name = '' THEN contacts.name
                 WHEN NOT ${maskedNameSql("excluded.name")} THEN excluded.name
                 WHEN contacts.name IS NULL OR contacts.name = '' THEN excluded.name
                 ELSE contacts.name
               END,
      notify = COALESCE(excluded.notify, contacts.notify),
      phone  = COALESCE(excluded.phone, contacts.phone)
  `);

  const upsertChatStmt = writer.prepare(`
    INSERT INTO chats (jid, name, last_msg_ts, unread, pinned, archived, muted_until, is_group, lid_jid)
    VALUES (?1, ?2, ?3, ?4, COALESCE(?5, 0), COALESCE(?6, 0), COALESCE(?7, 0), ?8, ?9)
    ON CONFLICT(jid) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != ''
                  THEN excluded.name ELSE chats.name END,
      last_msg_ts = CASE
        WHEN excluded.last_msg_ts IS NOT NULL
        THEN MAX(COALESCE(chats.last_msg_ts, 0), excluded.last_msg_ts)
        ELSE chats.last_msg_ts END,
      unread = CASE WHEN excluded.unread > 0 THEN excluded.unread ELSE chats.unread END,
      -- Pin, archive and mute are tri-state on the way in: NULL means the
      -- caller has no information (keep what is stored), anything else is
      -- the new truth, including 0 (unpinned, unarchived, unmuted) and, for
      -- mute, -1 (muted always). The old "excluded.x > 0" test dropped those:
      -- a chat muted "Always" on the phone after its row existed stayed
      -- unmuted here, and an unmute, unpin or unarchive never cleared, which
      -- for archive hid the chat from the list for good.
      pinned = COALESCE(?5, chats.pinned),
      archived = COALESCE(?6, chats.archived),
      muted_until = COALESCE(?7, chats.muted_until),
      is_group = COALESCE(excluded.is_group, chats.is_group),
      lid_jid = COALESCE(excluded.lid_jid, chats.lid_jid)
  `);

  const ensureChatStmt = writer.prepare(`
    INSERT OR IGNORE INTO chats (jid, is_group) VALUES (?1, ?2)
  `);

  const clearUnreadStmt = writer.prepare(`
    UPDATE chats SET unread = 0 WHERE jid = ?1 AND unread != 0
  `);

  const incrementUnreadStmt = writer.prepare(`
    UPDATE chats SET unread = COALESCE(unread, 0) + 1 WHERE jid = ?1
  `);

  const setChatMuteStmt = writer.prepare(`
    UPDATE chats SET muted_until = ?1 WHERE jid = ?2
  `);

  const getMetaStmt = writer.prepare<{ value: string }, [string]>(
    `SELECT value FROM app_meta WHERE key = ?1`
  );
  const setMetaStmt = writer.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const deleteChatStmt = writer.prepare(`DELETE FROM chats WHERE jid = ?1`);
  const deleteMessagesForChatStmt = writer.prepare(`DELETE FROM messages WHERE chat_jid = ?1`);
  const deleteParticipantsForGroupStmt = writer.prepare(`DELETE FROM group_participants WHERE group_jid = ?1`);

  const markMessageDeletedStmt = writer.prepare(`
    UPDATE messages
       SET text = '[deleted]',
           media_type = NULL,
           media_path = NULL,
           media_url = NULL,
           media_key = NULL,
           direct_path = NULL,
           thumbnail = NULL
     WHERE id = ?1
  `);

  const setReactionStmt = writer.prepare(`
    UPDATE messages SET react_emoji = ?1 WHERE id = ?2
  `);

  const insertMsgStmt = writer.prepare(`
    INSERT OR REPLACE INTO messages
      (id, chat_jid, sender_jid, from_me, timestamp, type, text,
       media_type, media_path, media_key, direct_path, media_url,
       mimetype, file_name, file_size, width, height, thumbnail,
       quoted_id, status, push_name)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
  `);

  const updateStatusStmt = writer.prepare(`
    UPDATE messages SET status = ?1 WHERE id = ?2
  `);

  const updateMediaPathStmt = writer.prepare(`
    UPDATE messages SET media_path = ?1 WHERE id = ?2
  `);

  const upsertParticipantStmt = writer.prepare(`
    INSERT OR REPLACE INTO group_participants (group_jid, user_jid, role)
    VALUES (?1, ?2, ?3)
  `);

  const removeParticipantStmt = writer.prepare(`
    DELETE FROM group_participants WHERE group_jid = ?1 AND user_jid = ?2
  `);

  // ── Read statements ───────────────────────────────────────────

  // Note: the dedup filter for LID rows checks BOTH:
  //   1. chats.lid_jid back-reference (preferred — explicit link on the
  //      canonical phone row, set when baileys delivered lidJid/accountLid
  //      in the chat object)
  //   2. contacts.lid fallback (catches the case where baileys did NOT
  //      include lidJid in the chat metadata but the contacts table knows
  //      the LID → phone mapping from a separate contacts.upsert event)
  // The contacts.lid fallback is what closes the gap on installs where
  // chats.lid_jid is under-populated (e.g. christopher's 30% leakage).
  const listChatsStmt = reader.prepare<ChatRow, [number]>(`
    SELECT c.jid, c.name,
      COALESCE(
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = c.jid OR m.chat_jid = c.lid_jid),
        c.last_msg_ts
      ) as last_msg_ts,
      c.unread, c.pinned, c.archived, c.muted_until, c.is_group, c.lid_jid,
      (SELECT m.text FROM messages m
       WHERE m.chat_jid = c.jid OR m.chat_jid = c.lid_jid
       ORDER BY m.timestamp DESC LIMIT 1) as last_msg_text,
      (SELECT m.type FROM messages m
       WHERE m.chat_jid = c.jid OR m.chat_jid = c.lid_jid
       ORDER BY m.timestamp DESC LIMIT 1) as last_msg_type
    FROM chats c
    WHERE c.archived = 0
      AND c.jid != 'status@broadcast'
      AND NOT (c.jid LIKE '%@lid' AND (
        EXISTS (
          SELECT 1 FROM chats c2
          WHERE c2.lid_jid = c.jid AND c2.jid NOT LIKE '%@lid'
        )
        OR EXISTS (
          SELECT 1 FROM contacts ct
          WHERE ct.lid = c.jid
            AND ct.jid LIKE '%@s.whatsapp.net'
            AND EXISTS (SELECT 1 FROM chats cc WHERE cc.jid = ct.jid)
        )
      ))
    ORDER BY c.pinned DESC, last_msg_ts DESC
    LIMIT ?1
  `);

  const getChatStmt = reader.prepare<ChatRow, [string]>(`
    SELECT jid, name, last_msg_ts, unread, pinned, archived, muted_until, is_group, lid_jid
    FROM chats WHERE jid = ?1
  `);

  const getMessagesStmt = reader.prepare<MessageRow, [string, string, number, number]>(`
    SELECT id, chat_jid, sender_jid, from_me, timestamp, type, text,
           media_type, media_path, media_key, direct_path, media_url,
           mimetype, file_name, file_size, width, height, thumbnail,
           quoted_id, status, push_name, react_emoji
    FROM messages
    WHERE (chat_jid = ?1 OR chat_jid = ?2)
      AND (?3 = 0 OR timestamp < ?3)
    ORDER BY timestamp DESC
    LIMIT ?4
  `);

  // Within-chat full-text search. Case-insensitive substring on text only
  // (media-only messages don't appear in results — there's no body to match).
  const searchMessagesStmt = reader.prepare<MessageRow, [string, string, string, number]>(`
    SELECT id, chat_jid, sender_jid, from_me, timestamp, type, text,
           media_type, media_path, media_key, direct_path, media_url,
           mimetype, file_name, file_size, width, height, thumbnail,
           quoted_id, status, push_name, react_emoji
    FROM messages
    WHERE (chat_jid = ?1 OR chat_jid = ?2)
      AND text IS NOT NULL
      AND text != ''
      AND text LIKE ?3
    ORDER BY timestamp DESC
    LIMIT ?4
  `);

  const getMessageStmt = reader.prepare<MessageRow, [string]>(`
    SELECT * FROM messages WHERE id = ?1
  `);

  const getMessageContentStmt = reader.prepare<
    { text: string | null; type: string },
    [string]
  >(`SELECT text, type FROM messages WHERE id = ?1`);

  const getContactStmt = reader.prepare<ContactRow, [string]>(
    `SELECT * FROM contacts WHERE jid = ?1`
  );

  // WhatsApp sometimes sends a PRIVACY-MASKED phone number as a contact's
  // `name` (e.g. "+62∙∙∙∙∙∙∙∙∙59", U+2219 BULLET OPERATOR, or U+2022 BULLET)
  // instead of withholding the field. A naive COALESCE(name, notify, ...)
  // then shadows the real push name sitting in `notify`, and the contact
  // renders as a number forever. Seen in bulk after the 2026-08-14 re-link:
  // 25 contacts arrived with masked names, 9 of which had a perfectly good
  // `notify`. Treat a masked name as ABSENT so the fallback chain continues.
  //
  // Deliberately a display-layer fix, not an ingest-layer one: the mask is
  // still the best label we have for a contact with no `notify`, so it stays
  // stored and is used as a last resort below.
  const UNMASKED_NAME = `CASE WHEN ${maskedNameSql("name")} THEN NULL ELSE NULLIF(name, '') END`;

  // Under the LID rollout one person can have two rows: the phone-JID row
  // (carrying `lid`) and a row keyed by the @lid JID itself, which is where
  // Baileys files the push name of a LID-addressed group message. When this
  // row has no usable name of its own, borrow the sibling's push name before
  // settling for a mask or a bare number.
  const SIBLING_NOTIFY = `(
    SELECT s.notify FROM contacts s
    WHERE (s.jid = contacts.lid OR s.lid = contacts.jid)
      AND s.jid != contacts.jid AND s.notify IS NOT NULL AND s.notify != ''
    LIMIT 1)`;

  const RESOLVED_NAME =
    `COALESCE(${UNMASKED_NAME}, NULLIF(notify, ''), ${SIBLING_NOTIFY}, NULLIF(name, ''), phone, jid)`;

  const resolveNameStmt = reader.prepare<{ resolved: string }, [string]>(
    `SELECT ${RESOLVED_NAME} AS resolved FROM contacts WHERE jid = ?1`
  );

  const resolveNameByLidStmt = reader.prepare<{ resolved: string }, [string]>(
    `SELECT ${RESOLVED_NAME} AS resolved FROM contacts WHERE lid = ?1`
  );

  const searchContactsStmt = reader.prepare<ContactRow, [string]>(`
    SELECT * FROM contacts
    WHERE name LIKE ?1 OR notify LIKE ?1 OR phone LIKE ?1 OR jid LIKE ?1
    ORDER BY COALESCE(${UNMASKED_NAME}, NULLIF(notify, ''), NULLIF(name, ''), jid)
    LIMIT 50
  `);

  const getParticipantsStmt = reader.prepare<GroupParticipantRow, [string]>(
    `SELECT * FROM group_participants WHERE group_jid = ?1`
  );

  const countContactsStmt = reader.prepare<{ c: number }, []>(
    `SELECT COUNT(*) AS c FROM contacts`
  );
  const countChatsStmt = reader.prepare<{ c: number }, []>(
    `SELECT COUNT(*) AS c FROM chats`
  );
  const countMessagesStmt = reader.prepare<{ c: number }, []>(
    `SELECT COUNT(*) AS c FROM messages`
  );

  // ── Helper: get LID JID for a chat ────────────────────────────

  const getLidJidStmt = reader.prepare<{ lid_jid: string | null }, [string]>(
    `SELECT lid_jid FROM chats WHERE jid = ?1`
  );

  function getLidJid(chatJid: string): string {
    return getLidJidStmt.get(chatJid)?.lid_jid ?? chatJid;
  }

  // ── Helper: resolve @lid JID → phone @s.whatsapp.net JID ──────

  const lidToPhoneStmt = reader.prepare<{ jid: string }, [string]>(`
    SELECT c.jid FROM chats c WHERE c.lid_jid = ?1 AND c.jid NOT LIKE '%@lid' LIMIT 1
  `);

  const lidToPhoneContactStmt = reader.prepare<{ jid: string }, [string]>(`
    SELECT c.jid FROM contacts c WHERE c.lid = ?1 AND c.jid LIKE '%@s.whatsapp.net' LIMIT 1
  `);

  function resolveLidToPhone(lidJid: string): string {
    if (!lidJid.endsWith("@lid")) return lidJid;
    // Try chats table first (lid_jid column)
    const fromChat = lidToPhoneStmt.get(lidJid);
    if (fromChat) return fromChat.jid;
    // Try contacts table (lid column)
    const fromContact = lidToPhoneContactStmt.get(lidJid);
    if (fromContact) return fromContact.jid;
    return lidJid;
  }

  // ── Internal helpers ────────────────────────────────────────────

  const CHUNK = 1500;

  function runInChunks<T>(items: T[], fn: (item: T) => void) {
    for (let i = 0; i < items.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, items.length);
      writer.transaction(() => {
        for (let j = i; j < end; j++) {
          const item = items[j];
          if (item !== undefined) fn(item);
        }
      })();
    }
  }

  function runContactUpsert(c: ContactRow) {
    upsertContactStmt.run(
      c.jid, c.lid ?? null, c.name ?? null, c.notify ?? null, c.phone ?? null
    );
  }

  function runChatUpsert(c: ChatRow) {
    upsertChatStmt.run(
      c.jid, c.name ?? null, c.last_msg_ts ?? null,
      c.unread ?? 0, c.pinned ?? null, c.archived ?? null,
      c.muted_until ?? null, c.is_group ?? 0, c.lid_jid ?? null
    );
  }

  const ensuredChats = new Set<string>();

  function runMessageInsert(m: MessageRow) {
    if (!ensuredChats.has(m.chat_jid)) {
      ensureChatStmt.run(String(m.chat_jid), m.chat_jid.endsWith("@g.us") ? 1 : 0);
      ensuredChats.add(m.chat_jid);
    }
    insertMsgStmt.run(
      String(m.id),
      String(m.chat_jid),
      m.sender_jid != null ? String(m.sender_jid) : null,
      m.from_me ? 1 : 0,
      Number(m.timestamp) || 0,
      String(m.type || "unknown"),
      m.text != null ? String(m.text) : null,
      m.media_type != null ? String(m.media_type) : null,
      m.media_path != null ? String(m.media_path) : null,
      m.media_key ?? null,
      m.direct_path ?? null,
      m.media_url ?? null,
      m.mimetype ?? null,
      m.file_name ?? null,
      m.file_size ?? null,
      m.width ?? null,
      m.height ?? null,
      m.thumbnail ?? null,
      m.quoted_id != null ? String(m.quoted_id) : null,
      Number(m.status) || 0,
      m.push_name != null ? String(m.push_name) : null
    );
  }

  // ── Return store ──────────────────────────────────────────────

  return {
    upsertContact(c) { runContactUpsert(c); },
    upsertChat(c) { runChatUpsert(c); },

    insertMessage(m) {
      try { runMessageInsert(m); }
      catch (e) { console.error(`[store] insertMessage failed: ${(e as Error)?.message}`); }
    },

    updateMessageStatus(id, status) {
      updateStatusStmt.run(status, id);
    },

    updateMediaPath(id, path) {
      updateMediaPathStmt.run(path, id);
    },

    clearUnread(jid: string) {
      clearUnreadStmt.run(jid);
    },

    incrementUnread(jid: string) {
      incrementUnreadStmt.run(jid);
    },

    setChatMute(jid, mutedUntil) {
      setChatMuteStmt.run(mutedUntil, jid);
    },

    getMeta(key) {
      return getMetaStmt.get(key)?.value ?? null;
    },

    setMeta(key, value) {
      setMetaStmt.run(key, value);
    },

    upsertGroupParticipants(groupJid, participants) {
      writer.transaction(() => {
        for (const p of participants) {
          upsertParticipantStmt.run(p.group_jid, p.user_jid, p.role ?? null);
        }
      })();
    },

    removeGroupParticipants(groupJid, userJids) {
      writer.transaction(() => {
        for (const jid of userJids) {
          removeParticipantStmt.run(groupJid, jid);
        }
      })();
    },

    bulkUpsertContacts(contacts) { runInChunks(contacts, runContactUpsert); },
    bulkUpsertChats(chats) { runInChunks(chats, runChatUpsert); },

    bulkInsertMessages(messages) {
      runInChunks(messages, (m) => {
        try { runMessageInsert(m); }
        catch (e) { console.error(`[store] bulkInsert failed: ${(e as Error)?.message}`); }
      });
    },

    deleteChat(jid) {
      writer.transaction(() => {
        deleteMessagesForChatStmt.run(jid);
        deleteParticipantsForGroupStmt.run(jid);
        deleteChatStmt.run(jid);
      })();
    },

    markMessageDeleted(id) {
      markMessageDeletedStmt.run(id);
    },

    setReaction(id, emoji) {
      setReactionStmt.run(emoji, id);
    },

    listChats(limit = 50) {
      return listChatsStmt.all(limit);
    },

    getChat(jid) {
      return getChatStmt.get(jid) ?? null;
    },

    getMessages(chatJid, limit = 30, beforeTs) {
      const lidJid = getLidJid(chatJid);
      return getMessagesStmt.all(chatJid, lidJid, beforeTs ?? 0, limit);
    },

    searchMessages(chatJid, query, limit = 50) {
      const lidJid = getLidJid(chatJid);
      // SQL LIKE pattern: case-insensitive matches via SQLite's default
      // LIKE behavior (case-insensitive for ASCII). For non-ASCII (emoji,
      // accented chars), case-sensitivity isn't a concern in practice.
      const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;
      return searchMessagesStmt.all(chatJid, lidJid, pattern, limit);
    },

    getMessage(id) {
      return getMessageStmt.get(id) ?? null;
    },

    getMessageContent(id) {
      return getMessageContentStmt.get(id) ?? null;
    },

    getContact(jid) {
      return getContactStmt.get(jid) ?? null;
    },

    resolveContactName(jid) {
      // For LID JIDs, check the lid column FIRST — the real contact
      // (with address book name) links via contacts.lid = @lid JID
      if (jid.endsWith("@lid")) {
        const byLid = resolveNameByLidStmt.get(jid)?.resolved;
        if (byLid) return byLid;
      }
      // Then try direct JID lookup
      const byJid = resolveNameStmt.get(jid)?.resolved;
      if (byJid && byJid !== jid) return byJid;
      // Fall back to the bare id portion of the JID. `split("@")[0]` is
      // technically `string | undefined` under noUncheckedIndexedAccess
      // but the regex split always returns at least one element, so we
      // assert it.
      return jid.split("@")[0] ?? jid;
    },

    searchContacts(query) {
      return searchContactsStmt.all(`%${query}%`);
    },

    getGroupParticipants(groupJid) {
      return getParticipantsStmt.all(groupJid);
    },

    countContacts() {
      return countContactsStmt.get()?.c ?? 0;
    },
    countChats() {
      return countChatsStmt.get()?.c ?? 0;
    },
    countMessages() {
      return countMessagesStmt.get()?.c ?? 0;
    },
    resolveLidToPhoneJid(lidJid: string) {
      return resolveLidToPhone(lidJid);
    },
  };
}
