import { appendFileSync } from "fs";

let _muted = false;
let _logFile: string | null = null;

export function muteLog() { _muted = true; }
export function unmuteLog() { _muted = false; }
export function setLogFile(path: string) { _logFile = path; }

function fileLog(level: string, tag: string, ...args: unknown[]) {
  if (!_logFile) return;
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  try { appendFileSync(_logFile, `${ts} [${level}][${tag}] ${msg}\n`); } catch {}
}

export const log = (tag: string, ...args: unknown[]) => {
  fileLog("LOG", tag, ...args);
  if (_muted) return;
  console.log(`\x1b[36m[${tag}]\x1b[0m`, ...args);
};

export const ok = (tag: string, ...args: unknown[]) => {
  fileLog("OK", tag, ...args);
  if (_muted) return;
  console.log(`\x1b[32m[${tag}]\x1b[0m`, ...args);
};

export const warn = (tag: string, ...args: unknown[]) => {
  fileLog("WARN", tag, ...args);
  if (_muted) return;
  console.log(`\x1b[33m[${tag}]\x1b[0m`, ...args);
};

export const err = (tag: string, ...args: unknown[]) => {
  fileLog("ERR", tag, ...args);
  if (_muted) return;
  console.log(`\x1b[31m[${tag}]\x1b[0m`, ...args);
};
