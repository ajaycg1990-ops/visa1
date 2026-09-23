import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.mjs";

/**
 * All cryptography for the product, in one auditable file.
 *
 *   - passwords: scrypt with a per-user salt
 *   - sessions and reset links: random tokens, HMAC-signed, stored only as
 *     SHA-256 hashes so a database copy cannot be replayed as a login
 *   - sensitive columns: AES-256-GCM with a key derived from
 *     DATA_ENCRYPTION_KEY, so applicant details are ciphertext at rest
 */

/* -------------------------------- passwords ------------------------------- */

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/**
 * Password rules. Deliberately about length and variety rather than a maze of
 * symbol requirements, which push users towards weaker, reused passwords.
 */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > 200) return "Password is too long.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

/* --------------------------------- tokens --------------------------------- */

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Hash used for anything stored in a token column. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A token is `<random>.<hmac>`. The HMAC lets the server reject forged or
 * corrupted tokens before it ever touches the database.
 */
export function createSignedToken() {
  const raw = randomBytes(32).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret).update(raw).digest("base64url");
  return `${raw}.${signature}`;
}

export function isTokenSignatureValid(token) {
  if (typeof token !== "string") return false;
  const [raw, signature] = token.split(".");
  if (!raw || !signature) return false;
  const expected = createHmac("sha256", config.sessionSecret).update(raw).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------- field-level encryption ------------------------- */

// One 32-byte key derived from the configured passphrase.
const ENCRYPTION_KEY = createHash("sha256").update(String(config.encryptionKey)).digest();
const ENCRYPTED_PREFIX = "enc:v1:";

/**
 * Encrypt one field. Returns `enc:v1:<iv>:<tag>:<ciphertext>` (all base64url).
 * Null/empty input passes through untouched so optional columns stay NULL.
 */
export function encryptField(value) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/**
 * Decrypt one field. Values that are not in the encrypted format are returned
 * as-is, which keeps the app readable if a row predates encryption.
 */
export function decryptField(value) {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_PREFIX)) return value ?? null;
  try {
    const [, , ivPart, tagPart, dataPart] = value.split(":");
    const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // A wrong key or tampered row must not crash a page render.
    return null;
  }
}

export function encryptJson(value) {
  if (value === null || value === undefined) return null;
  return encryptField(JSON.stringify(value));
}

export function decryptJson(value) {
  const text = decryptField(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------- utilities ------------------------------- */

export function isEmail(value) {
  return typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value.trim());
}

/** Constant-time string compare for non-secret-length-sensitive values. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
