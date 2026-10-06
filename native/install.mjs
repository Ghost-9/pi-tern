#!/usr/bin/env node
/** Install the pi-tern launcher: ~/.pi/tern/bin/pi-tern (+ ~/bin/pi-tern). */
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const source = path.resolve(new URL("./pi-tern.mjs", import.meta.url).pathname);
const root = process.env.PI_TERN_HOME || path.join(os.homedir(), ".pi", "tern");
const binDir = path.join(root, "bin");
const target = path.join(binDir, "pi-tern");
mkdirSync(binDir, { recursive: true });
if (existsSync(target)) unlinkSync(target);
symlinkSync(source, target);
chmodSync(source, 0o755);
const userBin = path.join(os.homedir(), "bin");
mkdirSync(userBin, { recursive: true });
const link = path.join(userBin, "pi-tern");
if (existsSync(link)) unlinkSync(link);
symlinkSync(target, link);
console.log(`installed: ${link} -> ${target} -> ${source}`);
