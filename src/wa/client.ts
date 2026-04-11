import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
  type WAMessageKey,
  type WAMessageContent,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { existsSync } from "fs";
import { log, ok, warn, err } from "../utils/log.ts";
import { AUTH_DIR } from "../utils/paths.ts";

export interface WaClient {
  sock: WASocket;
}

const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1035194821];

// Force reconnect if the socket is "open" but has received zero frames for this long.
// WhatsApp sends WS-level pings every ~20s, so 90s of silence means the socket is dead.
const LIVENESS_TIMEOUT_MS = 90_000;
const LIVENESS_CHECK_INTERVAL_MS = 30_000;

export interface ClientOptions {
  authDir?: string;
  logLevel?: string;
  onQr?: (qr: string) => void;
  onConnected?: (sock: WASocket) => void;
  onReconnecting?: (attempt: number) => void;
  onDisconnected?: (reason: number | undefined) => void;
  getMessage?: (key: WAMessageKey) => Promise<WAMessageContent | undefined>;
}

// ── Shared core ─────────────────────────────────────────────────────

function initClientCore(options: ClientOptions): {
  client: WaClient;
  connectedPromise: Promise<void>;
  start: () => Promise<void>;
} {
  const authDir = options.authDir ?? AUTH_DIR;
  const logLevel = options.logLevel ?? "silent";

  const hasSession = existsSync(`${authDir}/creds.json`);
  log("wa", hasSession ? "Session found — resuming" : "No session — QR auth required");

  let sock: WASocket;
  let resolveConnected: (() => void) | null = null;
  const connectedPromise = new Promise<void>((r) => { resolveConnected = r; });

  const client: WaClient = {
    get sock() { return sock!; },
  };

  async function fetchVersion(): Promise<[number, number, number]> {
    try {
      const result = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
      ]);
      log("wa", `WA Web version: ${result.version.join(".")} (latest: ${result.isLatest})`);
      return result.version;
    } catch {
      warn("wa", `Version fetch failed/timeout, using fallback`);
      return [...FALLBACK_WA_VERSION];
    }
  }

  async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const logger = pino({ level: logLevel }) as any;
    let version = await fetchVersion();

    let reconnectAttempt = 0;

    async function connect() {
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
        // Don't auto-broadcast 'available' on every connect. WhatsApp's server
        // suppresses phone push notifications whenever any linked device is
        // online, so we take explicit ownership of presence and flip it based
        // on terminal focus (see src/index.tsx focus→presence bridge).
        markOnlineOnConnect: false,
        getMessage: options.getMessage ?? (async () => undefined),
      });

      // Zombie-socket defense: after rapid 440/stream-replaced churn, the
      // socket can stay "open" forever without firing events. Track raw WS
      // frames (which include WA's ~20s server pings) and force a reconnect
      // if nothing arrives for LIVENESS_TIMEOUT_MS.
      let lastEventAt = Date.now();
      let isOpen = false;
      const bumpLiveness = () => { lastEventAt = Date.now(); };

      const ws = (sock as any).ws;
      if (ws?.on) {
        try { ws.on("message", bumpLiveness); } catch {}
      }

      const healthCheckInterval = setInterval(() => {
        if (!isOpen) return;
        const silentMs = Date.now() - lastEventAt;
        if (silentMs > LIVENESS_TIMEOUT_MS) {
          warn("wa", `Socket silent for ${Math.round(silentMs / 1000)}s — forcing reconnect`);
          clearInterval(healthCheckInterval);
          isOpen = false;
          try { sock.end(new Error("liveness timeout")); } catch {}
        }
      }, LIVENESS_CHECK_INTERVAL_MS);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (options.onQr) {
            options.onQr(qr);
          } else {
            log("auth", "Scan this QR code with WhatsApp:");
            qrcode.generate(qr, { small: true });
          }
        }

        if (connection === "close") {
          isOpen = false;
          clearInterval(healthCheckInterval);
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            err("wa", "Logged out. Delete auth_state/ and restart.");
            options.onDisconnected?.(statusCode);
            return;
          }

          if (statusCode === 405) {
            version = await fetchVersion();
          }

          if (reconnectAttempt < 5) {
            reconnectAttempt++;
            const delay = Math.min(reconnectAttempt * 2000, 10000);
            warn("wa", `Disconnected (${statusCode}), reconnecting in ${delay / 1000}s... (${reconnectAttempt}/5)`);
            options.onReconnecting?.(reconnectAttempt);
            await new Promise((r) => setTimeout(r, delay));
            connect();
          } else {
            // Reset and try one more cycle
            reconnectAttempt = 0;
            warn("wa", `Reconnect cycle exhausted, restarting connection...`);
            options.onReconnecting?.(0);
            await new Promise((r) => setTimeout(r, 5000));
            connect();
          }
        } else if (connection === "open") {
          reconnectAttempt = 0;
          isOpen = true;
          bumpLiveness();
          ok("wa", "Connected to WhatsApp!");
          const me = sock.user;
          if (me) {
            ok("wa", `JID: ${me.id} | Name: ${me.name || "(none)"} | LID: ${me.lid || "(none)"}`);
          }
          options.onConnected?.(sock);
          resolveConnected?.();
        }
      });

      sock.ev.on("creds.update", saveCreds);
    }

    connect();
  }

  return { client, connectedPromise, start };
}

// ── Blocking (REPL) ─────────────────────────────────────────────────

export async function createClient(options: ClientOptions = {}): Promise<WaClient> {
  const { client, connectedPromise, start } = initClientCore(options);
  await start();
  await connectedPromise;
  return client;
}

// ── Non-blocking (TUI) ─────────────────────────────────────────────

export function createClientNonBlocking(options: ClientOptions = {}): WaClient {
  const { client, start } = initClientCore(options);
  start(); // fire and forget
  return client;
}
