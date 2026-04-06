import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export interface DbInstances {
  writer: Database;
  reader: Database;
}

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  jid    TEXT PRIMARY KEY,
  lid    TEXT,
  name   TEXT,
  notify TEXT,
  phone  TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid) WHERE lid IS NOT NULL;

CREATE TABLE IF NOT EXISTS chats (
  jid         TEXT PRIMARY KEY,
  name        TEXT,
  last_msg_ts INTEGER,
  unread      INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  is_group    INTEGER NOT NULL DEFAULT 0,
  lid_jid     TEXT
);
CREATE INDEX IF NOT EXISTS idx_chats_order ON chats(pinned DESC, last_msg_ts DESC);
CREATE INDEX IF NOT EXISTS idx_chats_lid ON chats(lid_jid) WHERE lid_jid IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  sender_jid TEXT,
  from_me    INTEGER NOT NULL DEFAULT 0,
  timestamp  INTEGER NOT NULL,
  type       TEXT NOT NULL DEFAULT 'conversation',
  text       TEXT,
  media_type TEXT,
  media_path TEXT,
  media_key  TEXT,
  direct_path TEXT,
  media_url  TEXT,
  mimetype   TEXT,
  file_name  TEXT,
  file_size  INTEGER,
  width      INTEGER,
  height     INTEGER,
  thumbnail  TEXT,
  quoted_id  TEXT,
  status     INTEGER NOT NULL DEFAULT 0,
  push_name  TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);

CREATE TABLE IF NOT EXISTS group_participants (
  group_jid TEXT NOT NULL,
  user_jid  TEXT NOT NULL,
  role      TEXT,
  PRIMARY KEY (group_jid, user_jid)
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
`;

function applySchema(writer: Database) {
  writer.run("BEGIN");
  try {
    for (const stmt of SCHEMA_SQL.split(";").filter((s) => s.trim())) {
      writer.run(stmt);
    }
    const row = writer
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();
    if (!row) {
      writer.run("INSERT INTO schema_version VALUES (?)", [SCHEMA_VERSION]);
    }
    writer.run("COMMIT");
  } catch (e) {
    writer.run("ROLLBACK");
    throw e;
  }
}

function migrate(writer: Database) {
  const row = writer
    .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
    .get();
  const current = row?.version ?? 0;

  if (current < 2) {
    const addCol = (col: string, type: string) => {
      try { writer.run(`ALTER TABLE messages ADD COLUMN ${col} ${type}`); } catch {}
    };
    addCol("media_key", "TEXT");
    addCol("direct_path", "TEXT");
    addCol("media_url", "TEXT");
    addCol("mimetype", "TEXT");
    addCol("file_name", "TEXT");
    addCol("file_size", "INTEGER");
    addCol("width", "INTEGER");
    addCol("height", "INTEGER");
    addCol("thumbnail", "TEXT");
  }

  if (current < SCHEMA_VERSION) {
    writer.run("UPDATE schema_version SET version = ?", [SCHEMA_VERSION]);
  }
}

export function initDb(dbPath = "./data/app.db"): DbInstances {
  mkdirSync(dirname(dbPath), { recursive: true });

  const writer = new Database(dbPath, { strict: true });
  writer.run("PRAGMA journal_mode = WAL");
  writer.run("PRAGMA synchronous = NORMAL");
  writer.run("PRAGMA foreign_keys = ON");
  writer.run("PRAGMA cache_size = -32000");
  writer.run("PRAGMA busy_timeout = 5000");

  applySchema(writer);
  migrate(writer);

  const reader = new Database(dbPath, { readonly: true, strict: true });
  reader.run("PRAGMA cache_size = -32000");
  reader.run("PRAGMA busy_timeout = 5000");

  return { writer, reader };
}

export function closeDb(db: DbInstances) {
  try {
    db.writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.error(`[db] WAL checkpoint failed: ${(e as Error)?.message}`);
  }
  db.writer.close();
  db.reader.close();
}
