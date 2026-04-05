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

export interface WaClient {
  sock: WASocket;
}

export interface ClientOptions {
  authDir?: string;
  logLevel?: string;
  onQr?: (qr: string) => void;
  onConnected?: (sock: WASocket) => void;
  onDisconnected?: (reason: number | undefined) => void;
  getMessage?: (key: WAMessageKey) => Promise<WAMessageContent | undefined>;
}

export async function createClient(options: ClientOptions = {}): Promise<WaClient> {
  const authDir = options.authDir ?? "./auth_state";
  const logLevel = options.logLevel ?? "silent";

  const hasSession = existsSync(`${authDir}/creds.json`);
  log("wa", hasSession ? "Session found — resuming" : "No session — QR auth required");

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const logger = pino({ level: logLevel }) as any;
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log("wa", `WA Web version: ${version.join(".")} (latest: ${isLatest})`);

  let reconnectAttempt = 0;
  let sock: WASocket;
  let resolveConnected: (() => void) | null = null;
  const connectedPromise = new Promise<void>((r) => { resolveConnected = r; });

  function connect() {
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
      getMessage: options.getMessage ?? (async () => undefined),
    });

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
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          err("wa", "Logged out. Delete auth_state/ and restart.");
          options.onDisconnected?.(statusCode);
          return;
        }

        if (reconnectAttempt < 5) {
          reconnectAttempt++;
          const delay = Math.min(reconnectAttempt * 3000, 15000);
          warn("wa", `Disconnected (${statusCode}), reconnecting in ${delay / 1000}s... (${reconnectAttempt}/5)`);
          await new Promise((r) => setTimeout(r, delay));
          connect();
        } else {
          err("wa", `Max reconnection attempts. Last error: ${statusCode}`);
          options.onDisconnected?.(statusCode);
        }
      } else if (connection === "open") {
        reconnectAttempt = 0;
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

  // Wait for first successful connection before returning
  await connectedPromise;

  return {
    get sock() {
      return sock!;
    },
  };
}
