import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { openDb } from "./db.js";

const COOKIE = "iv_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const buckets = new Map();

export function clientIp(req) {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.trim()) return fly.trim();
  return req.socket.remoteAddress || "unknown";
}

export function allow(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { n: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.n += 1;
  if (buckets.size > 5000) {
    for (const [name, value] of buckets) {
      if (now > value.reset) buckets.delete(name);
    }
  }
  return bucket.n <= limit;
}

export function authConfigured() {
  return Boolean(process.env.ALLOWED_EMAIL && process.env.APP_PASSPHRASE && process.env.SESSION_SECRET);
}

export function loginOk(email, passphrase) {
  const allowed = String(process.env.ALLOWED_EMAIL || "").trim().toLowerCase();
  const secret = String(process.env.APP_PASSPHRASE || "");
  const givenEmail = String(email || "").trim().toLowerCase();
  const givenPass = String(passphrase || "");
  const emailMatch = sameSecret(givenEmail, allowed);
  const passMatch = sameSecret(givenPass, secret);
  return Boolean(allowed && secret && emailMatch && passMatch);
}

export function signSession(email) {
  const normalized = String(email).trim().toLowerCase();
  const id = randomBytes(32).toString("base64url");
  const database = openDb();
  database.prepare("DELETE FROM auth_sessions WHERE exp < ?").run(Date.now());
  database.prepare("INSERT INTO auth_sessions (id, email, exp) VALUES (?, ?, ?)").run(id, normalized, Date.now() + SESSION_MS);
  return id;
}

export function destroySession(req) {
  const token = readCookie(req, COOKIE);
  if (token) openDb().prepare("DELETE FROM auth_sessions WHERE id = ?").run(token);
}

export function readSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = openDb().prepare("SELECT email, exp FROM auth_sessions WHERE id = ?").get(token);
  if (!row) return null;
  const allowed = String(process.env.ALLOWED_EMAIL || "").trim().toLowerCase();
  if (Date.now() > row.exp || row.email !== allowed) {
    openDb().prepare("DELETE FROM auth_sessions WHERE id = ?").run(token);
    return null;
  }
  return { email: row.email };
}

export function sessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`;
}

export function clearCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function sameSecret(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}
