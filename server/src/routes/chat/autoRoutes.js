import express from "express";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const files = fs.readdirSync(__dirname);

for (const file of files) {
  if (file === "index.js") continue;

  const name = file.replace(".js", "");
  const mod = await import(`./${file}`);

  router.use(`/${name}`, mod.default);
}

export default router;
