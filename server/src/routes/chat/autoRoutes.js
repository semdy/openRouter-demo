import express from "express";
import fs from "node:fs";
import path from "node:path";

const router = express.Router();
const dirUrl = new URL(".", import.meta.url);
const files = fs.readdirSync(dirUrl).filter((file) => file.endsWith(".js"));

for (const file of files) {
  if (
    file.endsWith("index.js") ||
    file.endsWith("autoRoutes.js") ||
    file.endsWith("shared.js")
  ) {
    continue;
  }

  const name = file.replace(".js", "");
  const mod = await import(new URL(`./${file}`, import.meta.url));

  const handler = mod.default;

  if (typeof handler !== "function") {
    throw new Error(`Route file ${file} must export default router`);
  }

  router.use(`/${name}`, handler);
}

export default router;
