import type { Database } from "bun:sqlite";
import type { DbInstances } from "./db.ts";

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
  pinned?: number;
  archived?: number;
  muted_until?: number;
  is_group?: number;
  lid_jid?: string | null;
  last_msg_text?: string | null;
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
  quoted_id?: string | null;
  status: number;
  push_name?: string | null;
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
  upsertGroupParticipants(groupJid: string, participants: GroupParticipantRow[]): void;
  removeGroupParticipants(groupJid: string, userJids: string[]): void;
  bulkUpsertContacts(contacts: ContactRow[]): void;
  bulkUpsertChats(chats: ChatRow[]): void;
  bulkInsertMessages(messages: MessageRow[]): void;

  // Read
  listChats(limit?: number): ChatRow[];
  getMessages(chatJid: string, limit?: number, beforeTs?: number): MessageRow[];
  getMessage(id: string): MessageRow | null;
  getMessageContent(id: string): { text: string | null; type: string } | null;
  getContact(jid: string): ContactRow | null;
  resolveContactName(jid: string): string;
  searchContacts(query: string): ContactRow[];
  getGroupParticipants(groupJid: string): GroupParticipantRow[];
  countContacts(): number;
  countChats(): number;
  countMessages(): number;
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
      name   = COALESCE(excluded.name, contacts.name),
      notify = COALESCE(excluded.notify, contacts.notify),
      phone  = COALESCE(excluded.phone, contacts.phone)
  `);

  const upsertChatStmt = writer.prepare(`
    INSERT INTO chats (jid, name, last_msg_ts, unread, pinned, archived, muted_until, is_group, lid_jid)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(jid) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != ''
                  THEN excluded.name ELSE chats.name END,
      last_msg_ts = CASE
        WHEN excluded.last_msg_ts IS NOT NULL
        THEN MAX(COALESCE(chats.last_msg_ts, 0), excluded.last_msg_ts)
        ELSE chats.last_msg_ts END,
      unread = CASE WHEN excluded.unread > 0 THEN excluded.unread ELSE chats.unread END,
      pinned = CASE WHEN excluded.pinned > 0 THEN excluded.pinned ELSE chats.pinned END,
      archived = CASE WHEN excluded.archived > 0 THEN excluded.archived ELSE chats.archived END,
      muted_until = CASE WHEN excluded.muted_until > 0 THEN excluded.muted_until ELSE chats.muted_until END,
      is_group = COALESCE(excluded.is_group, chats.is_group),
      lid_jid = COALESCE(excluded.lid_jid, chats.lid_jid)
  `);

  const ensureChatStmt = writer.prepare(`
    INSERT OR IGNORE INTO chats (jid, is_group) VALUES (?1, ?2)
  `);

  const insertMsgStmt = writer.prepare(`
    INSERT OR REPLACE INTO messages
      (id, chat_jid, sender_jid, from_me, timestamp, type, text,
       media_type, media_path, quoted_id, status, push_name)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `);

  const updateStatusStmt = writer.prepare(`
    UPDATE messages SET status = ?1 WHERE id = ?2
  `);

  const upsertParticipantStmt = writer.prepare(`
    INSERT OR REPLACE INTO group_participants (group_jid, user_jid, role)
    VALUES (?1, ?2, ?3)
  `);

  const removeParticipantStmt = writer.prepare(`
    DELETE FROM group_participants WHERE group_jid = ?1 AND user_jid = ?2
  `);

  // ── Read statements ───────────────────────────────────────────

  const listChatsStmt = reader.prepare<ChatRow, [number]>(`
    SELECT c.jid, c.name,
      COALESCE(
        (SELECT MAX(m.timestamp) FROM messages m WHERE m.chat_jid = c.jid OR m.chat_jid = c.lid_jid),
        c.last_msg_ts
      ) as last_msg_ts,
      c.unread, c.pinned, c.archived, c.muted_until, c.is_group, c.lid_jid,
      (SELECT m.text FROM messages m
       WHERE m.chat_jid = c.jid OR m.chat_jid = c.lid_jid
       ORDER BY m.timestamp DESC LIMIT 1) as last_msg_text
    FROM chats c
    WHERE c.archived = 0
      AND c.jid != 'status@broadcast'
      AND NOT (c.jid LIKE '%@lid' AND EXISTS (
        SELECT 1 FROM chats c2 WHERE c2.lid_jid = c.jid AND c2.jid NOT LIKE '%@lid'
      ))
    ORDER BY c.pinned DESC, last_msg_ts DESC
    LIMIT ?1
  `);

  const getMessagesStmt = reader.prepare<MessageRow, [string, string, number, number]>(`
    SELECT id, chat_jid, sender_jid, from_me, timestamp, type, text,
           media_type, media_path, quoted_id, status, push_name
    FROM messages
    WHERE (chat_jid = ?1 OR chat_jid = ?2)
      AND (?3 = 0 OR timestamp < ?3)
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

  const resolveNameStmt = reader.prepare<{ resolved: string }, [string]>(
    `SELECT COALESCE(name, notify, phone, jid) AS resolved FROM contacts WHERE jid = ?1`
  );

  const resolveNameByLidStmt = reader.prepare<{ resolved: string }, [string]>(
    `SELECT COALESCE(name, notify, phone, jid) AS resolved FROM contacts WHERE lid = ?1`
  );

  const searchContactsStmt = reader.prepare<ContactRow, [string]>(`
    SELECT * FROM contacts
    WHERE name LIKE ?1 OR notify LIKE ?1 OR phone LIKE ?1 OR jid LIKE ?1
    ORDER BY COALESCE(name, notify, jid)
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

  // ── Internal helpers ────────────────────────────────────────────

  const CHUNK = 1500;

  function runInChunks<T>(items: T[], fn: (item: T) => void) {
    for (let i = 0; i < items.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, items.length);
      writer.transaction(() => {
        for (let j = i; j < end; j++) fn(items[j]);
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
      c.unread ?? 0, c.pinned ?? 0, c.archived ?? 0,
      c.muted_until ?? 0, c.is_group ?? 0, c.lid_jid ?? null
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

    listChats(limit = 50) {
      return listChatsStmt.all(limit);
    },

    getMessages(chatJid, limit = 30, beforeTs) {
      const lidJid = getLidJid(chatJid);
      return getMessagesStmt.all(chatJid, lidJid, beforeTs ?? 0, limit);
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
      return jid.split("@")[0];
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
  };
}
