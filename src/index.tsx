import { initDb, closeDb } from "./store/db.ts";
import { initQueries, type StoreQueries } from "./store/queries.ts";
import { createClient, createClientNonBlocking, type WaClient } from "./wa/client.ts";
import { registerHandlers } from "./wa/handlers.ts";
import { createInterface } from "readline";
import { existsSync } from "fs";
import { log, ok, warn, err } from "./utils/log.ts";
import type { WASocket } from "@whiskeysockets/baileys";

// ── REPL (Phase 1 — preserved as --repl fallback) ─────────────────

function printHelp() {
  console.log(`
\x1b[1mwhatsapp-tui-ts — Commands\x1b[0m

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
      const limit = parseInt(parts[1]!) || 30;
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
      const limit = parseInt(parts[2]!) || 20;
      const messages = store.getMessages(jid, limit);
      if (!messages.length) {
        warn("msgs", `No messages found for ${jid}`);
        break;
      }
      log("msgs", `${messages.length} messages (newest first):`);
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
        const meta = await client.sock.groupMetadata(jid);
        ok("group", `${meta.subject || jid} — ${meta.participants.length} participants:`);
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

function shutdown(client: WaClient | null, db: ReturnType<typeof initDb>) {
  log("shutdown", "Closing...");
  try { client?.sock.end(undefined); } catch {}
  closeDb(db);
  process.exit(0);
}

// ── REPL Main ───────────────────────────────────────────────────────

async function runRepl() {
  log("init", "whatsapp-tui-ts (REPL mode)");

  const db = initDb();
  const store = initQueries(db);
  ok("init", "SQLite initialized (WAL mode)");

  const hasAuth = existsSync("./auth_state/creds.json");
  const hasData = store.countChats() > 0;
  if (hasAuth && !hasData) {
    warn("init", "Auth state exists but DB is empty — delete auth_state/ and data/ together, then re-scan QR.");
  }

  const client = await createClient({
    getMessage: async (key) => {
      if (!key.id) return undefined;
      const row = store.getMessageContent(key.id);
      if (!row?.text) return undefined;
      return { conversation: row.text };
    },
    onConnected: (sock) => {
      registerHandlers(sock, store);
      log("sync", "History sync running in background...");
    },
  });

  ok("stats", `${store.countContacts()} contacts, ${store.countChats()} chats, ${store.countMessages()} messages (syncing...)`);

  startRepl(client, store, db);

  process.on("SIGINT", () => shutdown(client, db));
  process.on("SIGTERM", () => shutdown(client, db));
}

// ── TUI Main ────────────────────────────────────────────────────────

async function runTui() {
  const { muteLog, setLogFile } = await import("./utils/log.ts");
  const { render } = await import("@opentui/solid");
  const { createCliRenderer } = await import("@opentui/core");
  const { createAppStore, AppStoreProvider } = await import("./ui/state.tsx");
  const { ThemeProvider } = await import("./ui/theme.tsx");
  const { App } = await import("./ui/app.tsx");

  // Mute console logs — TUI owns the terminal; log to file instead
  setLogFile("./data/tui.log");
  muteLog();

  const db = initDb();
  const queries = initQueries(db);

  // Hydrate store from SQLite
  const [appStore, setAppStore, helpers] = createAppStore(queries);
  helpers.hydrate();

  let currentSock: WASocket | null = null;

  // Start connection (non-blocking — TUI renders immediately)
  const client = createClientNonBlocking({
    onQr: (qr) => helpers.setConnection({ status: "qr", qrData: qr }),
    onConnected: (sock) => {
      currentSock = sock;
      const bridge = helpers.createBridge();
      registerHandlers(sock, queries, bridge);
      helpers.setConnection({ status: "connected" });
      helpers.hydrate();
    },
    onReconnecting: (attempt) =>
      helpers.setConnection({ status: "reconnecting", reconnectAttempt: attempt }),
    onDisconnected: (reason) =>
      helpers.setConnection({ status: "disconnected" }),
    getMessage: async (key) => {
      if (!key.id) return undefined;
      const row = queries.getMessageContent(key.id);
      if (!row?.text) return undefined;
      return { conversation: row.text };
    },
  });

  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
  });

  function quit() {
    // Destroy renderer first to restore terminal state
    try { renderer.destroy(); } catch {}
    // Restore terminal fully — clear alt screen + any image artifacts
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[2J\x1b[H");
    try { client.sock?.end?.(undefined); } catch {}
    closeDb(db);
    process.exit(0);
  }

  await render(
    () => (
      <AppStoreProvider store={appStore} setStore={setAppStore} helpers={helpers}>
        <ThemeProvider>
          <App
            queries={queries}
            getSock={() => currentSock}
            getRenderer={() => renderer}
            onQuit={quit}
          />
        </ThemeProvider>
      </AppStoreProvider>
    ),
    renderer
  );
}

// ── Entry Point ─────────────────────────────────────────────────────

const isRepl = process.argv.includes("--repl");

(isRepl ? runRepl() : runTui()).catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
