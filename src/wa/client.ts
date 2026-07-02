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
import { notify } from "../utils/notify.ts";
import { AUTH_DIR } from "../utils/paths.ts";
import {
  computeReconnect,
  RECONNECT_INITIAL,
  STABLE_OPEN_MS,
  CB_COOLDOWN_CEILING_MS,
  CONNECT_BUDGET,
  BUDGET_FLOOR_MS,
  type ReconnectState,
} from "./reconnect.ts";
import {
  loadReconnectPersist,
  saveReconnectPersist,
  clearReconnectPersist,
  pruneConnectTimes,
  type CooldownReason,
} from "./reconnect-store.ts";

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
  log("wa", hasSession ? "Session found, resuming" : "No session, QR auth required");

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

    let reconnectState: ReconnectState = { ...RECONNECT_INITIAL };
    let connectTimes: number[] = [];
    let overBudgetNotified = false;
    let penaltyNotified = false;

    const persistNow = (cooldownUntil: number, reason: CooldownReason) => {
      saveReconnectPersist({
        savedAt: Date.now(),
        cooldownUntil,
        reason,
        state: reconnectState,
        connectTimes,
      });
    };

    // Accept only "1"/"true": a truthiness check would treat
    // WA_TUI_IGNORE_COOLDOWN=0 as "skip the safeguard", the opposite of
    // what the user asked for.
    const ignoreCooldown = ["1", "true"].includes(
      (process.env.WA_TUI_IGNORE_COOLDOWN ?? "").toLowerCase(),
    );

    // Resume breaker/cooldown state from a previous run. Without this, any
    // restart (brew upgrade, in-app Ctrl+P restart, crash) forgot a pending
    // penalty-box cooldown and fired an immediate fresh login burst; the
    // 2026-06-30 storm was sustained by exactly that. Deliberate probing can
    // skip the wait with WA_TUI_IGNORE_COOLDOWN=1. A machine with no session
    // (fresh link, or a re-pair after logout) starts clean instead: stale
    // penalized counters must not haunt a brand-new link.
    if (!hasSession) {
      clearReconnectPersist();
    }
    const persisted = hasSession ? loadReconnectPersist(Date.now()) : null;
    if (persisted) {
      reconnectState = persisted.state;
      connectTimes = persisted.connectTimes;
      const remaining = persisted.cooldownUntil - Date.now();
      if (remaining > 30_000 && !ignoreCooldown) {
        const waitMs = Math.min(remaining, CB_COOLDOWN_CEILING_MS);
        const mins = Math.round(waitMs / 60_000);
        warn(
          "wa",
          `Resuming persisted ${persisted.reason} cooldown: waiting ${mins}m before connecting (WA_TUI_IGNORE_COOLDOWN=1 skips)`,
        );
        // Only a throttle-family wait warrants a system notification; an
        // ordinary backoff remainder is routine and just logs.
        if (persisted.reason !== "backoff") {
          penaltyNotified = true;
          notify({
            title: "wa-tui: resuming cooldown",
            body: `${mins}m of WhatsApp ${persisted.reason} cooldown left from the previous run`,
            chatJid: "wa-tui:penalty-box",
          });
        }
        options.onReconnecting?.(reconnectState.failures);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      // A process restart must not dodge the rolling connect budget either:
      // without this gate, a restart loop sustains the exact login rate the
      // budget exists to stop. The wait is relative to the LAST attempt, so
      // a start hours later proceeds immediately.
      const now = Date.now();
      connectTimes = pruneConnectTimes(connectTimes, now);
      if (connectTimes.length >= CONNECT_BUDGET && !ignoreCooldown) {
        const budgetWait = BUDGET_FLOOR_MS - (now - Math.max(...connectTimes));
        if (budgetWait > 0) {
          warn(
            "wa",
            `Connect budget spent (${connectTimes.length} attempts in 24h): waiting ${Math.round(budgetWait / 1000)}s before connecting`,
          );
          options.onReconnecting?.(reconnectState.failures);
          await new Promise((r) => setTimeout(r, budgetWait));
        }
      }
    }

    async function connect() {
      // Every connect attempt is a login WhatsApp's anti-abuse sees. Count it
      // against the rolling 24h budget and persist immediately so a restart
      // can't shed the history (this also clears any served cooldown).
      const attemptAt = Date.now();
      connectTimes = pruneConnectTimes([...connectTimes, attemptAt], attemptAt);
      persistNow(0, "backoff");

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.macOS("Desktop"),
        generateHighQualityLinkPreview: false,
        // Only request a full history sync when there is no registered identity
        // yet, i.e. a genuine first link (or a re-pair after creds were lost or
        // corrupted). After the 2026-06-30 storm we confirmed (two probes 80s
        // apart) that WhatsApp rejects the heavy full-history-sync handshake with
        // 428 while an account is in its post-storm penalty state, yet accepts a
        // lightweight connect. Gate on the PARSED creds (`creds.me`, the same
        // signal Baileys uses to choose login vs register), read fresh on every
        // connect(): an established session already has its history in the local
        // DB and connects lightweight, a corrupt creds.json (me=undefined) still
        // backfills on re-pair, and a session linked mid-process drops to
        // lightweight as soon as `me` is populated (so reconnects don't re-trip).
        syncFullHistory: !state.creds.me,
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
      let openedAt: number | null = null; // when this socket reached 'open', for stability gating
      let stableResetTimer: ReturnType<typeof setTimeout> | null = null;
      const bumpLiveness = () => { lastEventAt = Date.now(); };

      const ws = (sock as any).ws;
      if (ws?.on) {
        try { ws.on("message", bumpLiveness); } catch {}
      }

      const healthCheckInterval = setInterval(() => {
        if (!isOpen) return;
        const silentMs = Date.now() - lastEventAt;
        if (silentMs > LIVENESS_TIMEOUT_MS) {
          warn("wa", `Socket silent for ${Math.round(silentMs / 1000)}s, forcing reconnect`);
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
          if (stableResetTimer) {
            clearTimeout(stableResetTimer);
            stableResetTimer = null;
          }
          const boom = lastDisconnect?.error as Boom | undefined;
          const statusCode = boom?.output?.statusCode;
          // Boom message discriminates a local ws.close ("Connection Terminated")
          // from a server-driven stream end ("Connection Terminated by Server").
          // Same numeric 428 either way, so log the string: it's the only signal.
          const reason = boom?.message;

          if (statusCode === DisconnectReason.loggedOut) {
            err("wa", "Logged out. Delete auth_state/ and restart.");
            clearReconnectPersist();
            options.onDisconnected?.(statusCode);
            return;
          }

          if (statusCode === 405) {
            version = await fetchVersion();
          }

          // Baileys' restartRequired (515) is the protocol-mandated immediate
          // reconnect that completes QR pairing. It is not a failure, so it
          // bypasses backoff, breaker, and budget alike; flooring it at ~10m
          // would strand a fresh link right after the QR scan.
          if (statusCode === DisconnectReason.restartRequired) {
            log("wa", "Restart required (pairing handshake), reconnecting immediately");
            connect();
            return;
          }

          // Did this connection stay open long enough to count as healthy? If
          // so the breaker accounting resets; a brief throttle flap does not.
          const wasStable = openedAt !== null && Date.now() - openedAt >= STABLE_OPEN_MS;
          openedAt = null;

          // Prune BEFORE deciding: a stale over-24h count would floor the
          // delay at ~10m after a perfectly healthy day-long session.
          connectTimes = pruneConnectTimes(connectTimes, Date.now());
          const decision = computeReconnect(
            reconnectState,
            statusCode,
            wasStable,
            Math.random,
            connectTimes.length,
          );
          reconnectState = decision.next;
          // Persist before sleeping so a restart mid-delay serves the
          // remainder instead of connecting immediately.
          persistNow(
            Date.now() + decision.delay,
            decision.inPenaltyBox ? "penalty-box" : decision.overBudget ? "budget" : "backoff",
          );

          if (decision.overBudget) {
            warn(
              "wa",
              `Connect budget exceeded (${connectTimes.length} attempts in 24h, budget ${CONNECT_BUDGET}): reconnect delay floored at ~10m`,
            );
            if (!overBudgetNotified) {
              overBudgetNotified = true;
              notify({
                title: "wa-tui: connection flapping",
                body: `${connectTimes.length} connect attempts in 24h (budget ${CONNECT_BUDGET}): slowing reconnects to ~10m`,
                chatJid: "wa-tui:budget",
              });
            }
          } else if (!decision.inPenaltyBox) {
            overBudgetNotified = false;
          }

          if (decision.inPenaltyBox) {
            warn(
              "wa",
              `428 penalty-box (run=${reconnectState.throttleRun}, cycle=${reconnectState.cooldownCycle}) [${reason ?? "?"}]: long cooldown ${Math.round(decision.delay / 60000)}m before retry`,
            );
            if (!penaltyNotified) {
              penaltyNotified = true;
              notify({
                title: "wa-tui: WhatsApp throttling",
                body: `Penalty box tripped: cooling down ${Math.round(decision.delay / 60000)}m before retry (cycle ${reconnectState.cooldownCycle})`,
                chatJid: "wa-tui:penalty-box",
              });
            }
          } else {
            penaltyNotified = false;
            warn(
              "wa",
              `Disconnected (${statusCode}${reason ? " " + reason : ""}), reconnecting in ${Math.round(decision.delay / 1000)}s (failure ${reconnectState.failures})`,
            );
          }

          options.onReconnecting?.(reconnectState.failures);
          await new Promise((r) => setTimeout(r, decision.delay));
          connect();
        } else if (connection === "open") {
          openedAt = Date.now();
          isOpen = true;
          bumpLiveness();
          // Heal the breaker once stability is proven and PERSIST the healed
          // state. Without this, penalized counters saved during a storm
          // survive a clean shutdown indefinitely and re-trip on the next
          // boot's first wobble.
          if (stableResetTimer) clearTimeout(stableResetTimer);
          stableResetTimer = setTimeout(() => {
            if (!isOpen) return;
            reconnectState = { ...RECONNECT_INITIAL };
            penaltyNotified = false;
            overBudgetNotified = false;
            persistNow(0, "backoff");
          }, STABLE_OPEN_MS);
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
