/**
 * Bun preload plugin: forces 'ws' imports to use the real npm package
 * instead of Bun's built-in polyfill (which is missing 'upgrade' and
 * 'unexpected-response' events that Baileys requires).
 */
import { plugin } from "bun";
import { resolve } from "path";

const realWsPath = resolve(import.meta.dir, "node_modules/ws/wrapper.mjs");

plugin({
  name: "ws-override",
  setup(build) {
    build.onResolve({ filter: /^ws$/ }, () => ({
      path: realWsPath,
    }));
  },
});
