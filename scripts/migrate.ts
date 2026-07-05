import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.PORTFOLIO_DB_PATH ?? "./data/portfolio.db";
mkdirSync(dirname(path), { recursive: true });

const db = new Database(path);
db.pragma("foreign_keys = ON");
db.exec(readFileSync("db/schema.sql", "utf8"));
console.log("migrated", path);
