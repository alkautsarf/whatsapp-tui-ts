/**
 * Single-instance lock via PID file at ~/.local/share/whatsapp-tui/wa.pid.
 *
 * WhatsApp's protocol allows only one active linked-device connection per
 * account at a time. If two `wa` instances launch with the same auth state,
 * they fight: each kicks the other off, the connection dot flickers between
 * green and yellow, and neither instance is usable.
 *
 * This module prevents that by writing the current process PID to a lock
 * file at startup and checking it on launch. If another process is alive
 * with a wa-tui-shaped command line, refuse to start. On clean exit, the
 * lock file is removed.
 *
 * Stale lock files (from a wa-tui process that died without releasing) are
 * detected and ignored — we check `process.kill(pid, 0)` for liveness AND
 * `ps -p <pid> -o command=` to confirm the PID is actually wa-tui (not some
 * unrelated process whose PID got recycled).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { APP_DIR } from "./paths.ts";

const LOCK_PATH = join(APP_DIR, "wa.pid");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWaTuiProcess(pid: number): boolean {
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
    return /bun.*src\/index\.tsx/.test(cmd) || /whatsapp-tui/.test(cmd);
  } catch {
    return false;
  }
}

export class InstanceLockError extends Error {
  constructor(public existingPid: number) {
    super(
      `Another whatsapp-tui instance is already running (PID ${existingPid}).\n` +
      `\n` +
      `WhatsApp only allows one active linked-device connection per account.\n` +
      `Running two instances simultaneously causes both to fight for the\n` +
      `connection — the green/yellow flicker in the status bar.\n` +
      `\n` +
      `To resolve:\n` +
      `  1. Find the existing instance:\n` +
      `       ps -p ${existingPid} -o command=\n` +
      `  2. Switch to it (likely in another tmux window) OR kill it:\n` +
      `       kill ${existingPid}\n` +
      `  3. Then re-run wa.\n` +
      `\n` +
      `If you're sure no other instance is running and the lock is stale:\n` +
      `       rm ${LOCK_PATH}\n`
    );
  }
}

export function acquireLock(): void {
  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, "utf-8").trim();
    const existingPid = parseInt(raw, 10);
    if (!Number.isNaN(existingPid) && isProcessAlive(existingPid) && isWaTuiProcess(existingPid)) {
      throw new InstanceLockError(existingPid);
    }
    // Stale lock — process is dead or not wa-tui. Fall through and overwrite.
  }
  writeFileSync(LOCK_PATH, String(process.pid), "utf-8");
}

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_PATH)) {
      const raw = readFileSync(LOCK_PATH, "utf-8").trim();
      const lockedPid = parseInt(raw, 10);
      // Only delete if the lock still belongs to us. Avoids racing with a
      // newer instance that took the lock after we crashed but before we ran
      // cleanup.
      if (lockedPid === process.pid) {
        unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // Best-effort cleanup. Don't crash on shutdown.
  }
}
