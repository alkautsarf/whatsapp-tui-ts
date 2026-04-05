export const log = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[36m[${tag}]\x1b[0m`, ...args);

export const ok = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[32m[${tag}]\x1b[0m`, ...args);

export const warn = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[33m[${tag}]\x1b[0m`, ...args);

export const err = (tag: string, ...args: unknown[]) =>
  console.log(`\x1b[31m[${tag}]\x1b[0m`, ...args);
