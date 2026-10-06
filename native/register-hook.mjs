import { register } from "node:module";

register(new URL("./patch.mjs", import.meta.url), import.meta.url);
