import { initDb, closeDb } from "./store/db.ts";
import { initQueries, type StoreQueries } from "./store/queries.ts";
import { createClient, type WaClient } from "./wa/client.ts";
import { registerHandlers } from "./wa/handlers.ts";
import { createInterface } from "readline";
import { existsSync } from "fs";
import { log, ok, warn, err } from "./utils/log.ts";

// ── REPL ────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
\x1b[1mwhatsapp-tui-ts Phase 1 — Commands\x1b[0m

  \x1b[36mchats\x1b[0m [n]           List top N chats (default 30)
  \x1b[36mmsgs\x1b[0m <jid> [n]      Show last N messages for a chat (default 20)
  \x1b[36mcontacts\x1b[0m [query]    Search/list contacts
  \x1b[36mcontact\x1b[0m <jid>       Show contact details
  \x1b[36mgroups\x1b[0m              List group chats
  \x1b[36mgroup\x1b[0m <jid>         Show group participants
  \x1b[36msend\x1b[0m <jid> <text>   Send a text message
  \x1b[36mstats\x1b[0m               Show DB counts
  \x1b[36mme\x1b[0m                  Show own JID info
  \x1b[36msql\x1b[0m <SELECT ...>    Run raw SELECT query
  \x1b[36mquit\x1b[0m                Graceful shutdown
  \x1b[36mhelp\x1b[0m                Show this help
`);
}

async function handleCommand(
  input: string,
  client: WaClient,
  store: StoreQueries,
  db: ReturnType<typeof initDb>
) {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "help":
    case "h":
      printHelp();
      break;

    case "chats": {
      const limit = parseInt(parts[1]) || 30;
      const chats = store.listChats(limit);
      log("chats", `${chats.length} chats:`);
      for (const c of chats) {
        const name = c.name || store.resolveContactName(c.jid);
        const time = c.last_msg_ts
          ? new Date(c.last_msg_ts * 1000).toLocaleString()
          : "?";
        const unread = c.unread ? ` (${c.unread} unread)` : "";
        console.log(`  ${name}${unread} — ${time} — ${c.jid}`);
      }
      break;
    }

    case "msgs": {
      const jid = parts[1];
      if (!jid) { warn("msgs", "Usage: msgs <jid> [limit]"); break; }
      const limit = parseInt(parts[2]) || 20;
      const messages = store.getMessages(jid, limit);
      if (!messages.length) {
        warn("msgs", `No messages found for ${jid}`);
        break;
      }
      log("msgs", `${messages.length} messages (newest first):`);
      // Reverse to show oldest first
      for (const m of [...messages].reverse()) {
        const time = new Date(m.timestamp * 1000).toLocaleTimeString();
        const sender = m.from_me ? "You" : (m.push_name || store.resolveContactName(m.sender_jid || m.chat_jid));
        const text = m.text ? `: ${m.text.slice(0, 80)}` : "";
        const status = m.from_me ? ` [${["?", "sent", "server", "delivered", "read"][m.status] ?? m.status}]` : "";
        console.log(`  [${time}] ${sender} (${m.type})${text}${status}`);
      }
      break;
    }

    case "contacts": {
      const query = parts.slice(1).join(" ");
      if (query) {
        const results = store.searchContacts(query);
        log("contacts", `${results.length} results for "${query}":`);
        for (const c of results) {
          console.log(`  ${c.name || c.notify || "(no name)"} — ${c.jid}${c.lid ? ` (LID: ${c.lid})` : ""}`);
        }
      } else {
        log("contacts", `Total: ${store.countContacts()}`);
      }
      break;
    }

    case "contact": {
      const jid = parts[1];
      if (!jid) { warn("contact", "Usage: contact <jid>"); break; }
      const c = store.getContact(jid);
      if (c) {
        ok("contact", JSON.stringify(c, null, 2));
      } else {
        warn("contact", `Not found: ${jid}`);
      }
      break;
    }

    case "groups": {
      const chats = store.listChats(500);
      const groups = chats.filter((c) => c.is_group);
      log("groups", `${groups.length} groups:`);
      for (const g of groups) {
        console.log(`  ${g.name || "(unnamed)"} — ${g.jid}`);
      }
      break;
    }

    case "group": {
      const jid = parts[1];
      if (!jid) { warn("group", "Usage: group <jid>"); break; }
      try {
        // Fetch live from WhatsApp (always fresh)
        const meta = await client.sock.groupMetadata(jid);
        ok("group", `${meta.subject || jid} — ${meta.participants.length} participants:`);
        // Store participants for future use
        store.upsertGroupParticipants(
          jid,
          meta.participants.map((p) => ({
            group_jid: jid,
            user_jid: p.id,
            role: p.admin ?? null,
          }))
        );
        for (const p of meta.participants) {
          const name = store.resolveContactName(p.id);
          const role = p.admin ? ` [${p.admin}]` : "";
          const nameLabel = name !== p.id.split("@")[0] ? ` — ${name}` : "";
          console.log(`  ${p.id}${role}${nameLabel}`);
        }
      } catch (e: any) {
        err("group", `Failed: ${e.message}`);
      }
      break;
    }

    case "send": {
      const jid = parts[1];
      const text = parts.slice(2).join(" ");
      if (!jid || !text) { warn("send", "Usage: send <jid> <text>"); break; }
      try {
        const result = await client.sock.sendMessage(jid, { text });
        ok("send", `Sent to ${jid} — id: ${result?.key?.id?.slice(0, 12)}...`);
      } catch (e: any) {
        err("send", `Failed: ${e.message}`);
      }
      break;
    }

    case "stats": {
      ok("stats", `Contacts: ${store.countContacts()}`);
      ok("stats", `Chats: ${store.countChats()}`);
      ok("stats", `Messages: ${store.countMessages()}`);
      break;
    }

    case "me": {
      const me = client.sock.user;
      if (me) {
        ok("me", `JID: ${me.id}`);
        ok("me", `Name: ${me.name || "(none)"}`);
        ok("me", `LID: ${me.lid || "(none)"}`);
      } else {
        warn("me", "Not connected");
      }
      break;
    }

    case "sql": {
      const query = parts.slice(1).join(" ");
      if (!query.trim().toLowerCase().startsWith("select")) {
        warn("sql", "Only SELECT queries allowed");
        break;
      }
      try {
        const results = db.reader.query(query).all();
        console.log(JSON.stringify(results, null, 2));
      } catch (e: any) {
        err("sql", e.message);
      }
      break;
    }

    case "quit":
    case "q":
    case "exit":
      return "quit";

    default:
      if (cmd) warn("repl", `Unknown command: ${cmd}. Type 'help'.`);
  }
}

function startRepl(client: WaClient, store: StoreQueries, db: ReturnType<typeof initDb>) {
  printHelp();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[35mwa>\x1b[0m ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const result = await handleCommand(line, client, store, db);
    if (result === "quit") {
      rl.close();
      return;
    }
    rl.prompt();
  });

  rl.on("close", () => {
    shutdown(client, db);
  });
}

// ── Shutdown ────────────────────────────────────────────────────────

function shutdown(client: WaClient, db: ReturnType<typeof initDb>) {
  log("shutdown", "Closing...");
  try { client.sock.end(undefined); } catch {}
  closeDb(db);
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  log("init", "whatsapp-tui-ts Phase 1");

  // 1. Init SQLite
  const db = initDb();
  const store = initQueries(db);
  ok("init", "SQLite initialized (WAL mode)");

  // 1.5. Check for DB/auth inconsistency
  const hasAuth = existsSync("./auth_state/creds.json");
  const hasData = store.countChats() > 0;
  if (hasAuth && !hasData) {
    warn("init", "Auth state exists but DB is empty — you may be missing historical messages.");
    warn("init", "To fix: delete auth_state/ and data/ together, then re-scan QR for full sync.");
  }

  // 2. Connect to WhatsApp (awaits until connection is open)
  const client = await createClient({
    getMessage: async (key) => {
      if (!key.id) return undefined;
      const row = store.getMessageContent(key.id);
      if (!row?.text) return undefined;
      return { conversation: row.text };
    },
    onConnected: (sock) => {
      // Register handlers immediately when connected so we don't miss events
      registerHandlers(sock, store);
      log("sync", "History sync running in background...");
    },
  });

  // 3. Print initial stats (sync continues in background)
  ok("stats", `${store.countContacts()} contacts, ${store.countChats()} chats, ${store.countMessages()} messages (syncing...)`);

  // 4. Start REPL
  startRepl(client, store, db);

  // 5. Graceful shutdown
  process.on("SIGINT", () => shutdown(client, db));
  process.on("SIGTERM", () => shutdown(client, db));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
