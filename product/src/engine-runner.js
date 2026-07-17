/**
 * Engine runner — loaded when the binary is spawned with --engine flag.
 * Reads all settings from env vars (set by the parent launcher process).
 *
 * In dev mode:  spawned as `node engine-runner.js`
 * In binary:   spawned as `./bot --engine` (process.pkg === true)
 */

import { resolve, dirname } from "path";
import { fileURLToPath }    from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// When running as a pkg binary the engine is bundled at a snapshot path.
// When running in dev mode it lives at ../../engine/topstepx-engine.js
const ENGINE_PATH = resolve(__dir, "../../engine/topstepx-engine.js");

await import(ENGINE_PATH);
