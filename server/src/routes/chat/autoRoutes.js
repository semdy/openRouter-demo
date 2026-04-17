import express from "express";
import fs from "fs";
import path from "path";

const router = express.Router();

const files = fs.readdirSync(__dirname);

for (const file of files) {
  if (file === "index.js") continue;

  const name = file.replace(".js", "");
  const mod = await import(`./${file}`);

  router.use(`/${name}`, mod.default);
}

export default router;
