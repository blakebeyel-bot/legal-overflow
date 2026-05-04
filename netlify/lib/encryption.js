/**
 * AES-256-GCM helpers for the BYOK API key store.
 *
 * Plaintext API keys never leave Node memory:
 *   - encryptForStorage(plaintext)  → ciphertext base64 (iv|tag|ct)
 *   - decryptFromStorage(ciphertext) → plaintext
 *
 * The 256-bit key lives in the BYOK_ENCRYPTION_KEY env var as a 64-char
 * hex string. Compromising the database alone does NOT leak user API
 * keys — an attacker also needs the env var.
 *
 * Format produced (base64):
 *   bytes  0–11   IV (12 bytes, GCM standard)
 *   bytes 12–27   auth tag (16 bytes)
 *   bytes 28+     ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.BYOK_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'BYOK_ENCRYPTION_KEY env var not set. Generate with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (hex.length !== 64) {
    throw new Error(`BYOK_ENCRYPTION_KEY must be 64 hex chars (32 bytes); got ${hex.length}`);
  }
  return Buffer.from(hex, 'hex');
}

export function encryptForStorage(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptFromStorage(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Last 4 chars of plaintext, for UI display ("key ending in ...xyz9").
 * NEVER reveals more than that — we only know the plaintext at
 * encryption time; the DB row stores the fingerprint then forgets the
 * plaintext.
 */
export function fingerprintForDisplay(plaintext) {
  if (!plaintext || plaintext.length < 4) return '****';
  return plaintext.slice(-4);
}
