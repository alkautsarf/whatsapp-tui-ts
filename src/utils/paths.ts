import { join } from "path";
import { mkdirSync } from "fs";

const HOME = process.env.HOME || "/tmp";
const DATA_HOME = process.env.XDG_DATA_HOME || join(HOME, ".local", "share");

export const APP_DIR = join(DATA_HOME, "whatsapp-tui");
export const AUTH_DIR = join(APP_DIR, "auth_state");
export const DB_PATH = join(APP_DIR, "app.db");
export const MEDIA_DIR = join(APP_DIR, "media");
export const LOG_PATH = join(APP_DIR, "tui.log");

// Ensure base directory exists on import
mkdirSync(APP_DIR, { recursive: true });
