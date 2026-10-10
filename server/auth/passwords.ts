import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Version 1 is a measured candidate, not an installation/login policy. Changing
// its work factor requires a new supported version, never a runtime fallback.
export const SCRYPT_V1 = Object.freeze({ version: 1, N: 131072, r: 8, p: 1, saltBytes: 32, keyBytes: 32 });
export const SCRYPT_V1_MAXMEM_BYTES = 160 * 1024 * 1024;
export const MAX_PASSWORD_BYTES = 1024;
export const MAX_PASSWORD_VERIFIER_BYTES = 256;

export type PasswordHashFailure = "invalid_password" | "invalid_verifier" | "unsupported_verifier" | "invalid_configuration" | "resource_budget" | "capacity" | "crypto_unavailable";
const messages: Record<PasswordHashFailure, string> = {
  invalid_password: "Password must be nonempty well-formed UTF-8 within the supported byte limit",
  invalid_verifier: "Password verifier is malformed",
  unsupported_verifier: "Password verifier parameters are unsupported",
  invalid_configuration: "Password hashing configuration is unsupported",
  resource_budget: "Password hashing memory budget cannot support the configured work",
  capacity: "Password hashing capacity is exhausted",
  crypto_unavailable: "Password hashing is unavailable",
};
export class PasswordHashError extends Error {
  readonly code: PasswordHashFailure;
  constructor(code: PasswordHashFailure) { super(messages[code]); this.name = "PasswordHashError"; this.code = code; }
}
export interface PasswordHashLimits { maxConcurrent?: number; memoryBudgetBytes?: number }
export interface PasswordHasher {
  readonly limits: Readonly<{ maxConcurrent: number; memoryBudgetBytes: number; maxmemPerOperationBytes: number }>;
  hash(password: string): Promise<string>;
  verify(password: string, verifier: unknown): Promise<boolean>;
}

function passwordBytes(password: string): Buffer {
  // Check JS length before allocating. UTF-8 encoding can otherwise alias lone
  // surrogates to the replacement character; reject that instead of normalizing.
  if (typeof password !== "string" || !password.length || password.length > MAX_PASSWORD_BYTES) throw new PasswordHashError("invalid_password");
  const bytes = Buffer.from(password, "utf8");
  if (bytes.length > MAX_PASSWORD_BYTES || bytes.toString("utf8") !== password) {
    bytes.fill(0); throw new PasswordHashError("invalid_password");
  }
  return bytes;
}
function canonicalBytes(value: string, length: number): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new PasswordHashError("invalid_verifier");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw new PasswordHashError("invalid_verifier");
  return bytes;
}
function parseVerifier(value: unknown): { salt: Buffer; key: Buffer } {
  if (typeof value !== "string" || value.length > MAX_PASSWORD_VERIFIER_BYTES || !/^[\x21-\x7e]+$/.test(value)) throw new PasswordHashError("invalid_verifier");
  const parts = value.split("$");
  if (parts.length !== 8 || !parts.slice(1, 6).every(part => /^(?:0|[1-9][0-9]{0,8})$/.test(part))) throw new PasswordHashError("invalid_verifier");
  if (parts[0] !== "scrypt" || parts[1] !== String(SCRYPT_V1.version) || parts[2] !== String(SCRYPT_V1.N)
    || parts[3] !== String(SCRYPT_V1.r) || parts[4] !== String(SCRYPT_V1.p) || parts[5] !== String(SCRYPT_V1.keyBytes)) throw new PasswordHashError("unsupported_verifier");
  return { salt: canonicalBytes(parts[6], SCRYPT_V1.saltBytes), key: canonicalBytes(parts[7], SCRYPT_V1.keyBytes) };
}
function derive(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_V1.keyBytes, { N: SCRYPT_V1.N, r: SCRYPT_V1.r, p: SCRYPT_V1.p, maxmem: SCRYPT_V1_MAXMEM_BYTES }, (error, key) => {
      if (error) reject(new PasswordHashError("crypto_unavailable"));
      else resolve(key);
    });
  });
}

// One instance must be owned by the server composition, not created per request.
// Native maxmem is an algorithm limit; this reservation is not a whole-process
// RSS cap. There is no waiting queue or cancellation that releases a live KDF.
export function createPasswordHasher(options: PasswordHashLimits = {}): PasswordHasher {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => key !== "maxConcurrent" && key !== "memoryBudgetBytes")) throw new PasswordHashError("invalid_configuration");
  const maxConcurrent = options.maxConcurrent === undefined ? 1 : options.maxConcurrent;
  const memoryBudgetBytes = options.memoryBudgetBytes === undefined ? SCRYPT_V1_MAXMEM_BYTES : options.memoryBudgetBytes;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2
    || !Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes > 2 * SCRYPT_V1_MAXMEM_BYTES) throw new PasswordHashError("invalid_configuration");
  if (memoryBudgetBytes < maxConcurrent * SCRYPT_V1_MAXMEM_BYTES) throw new PasswordHashError("resource_budget");
  let active = 0;
  async function admitted<T>(work: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) throw new PasswordHashError("capacity");
    active += 1;
    try { return await work(); }
    catch (error) {
      if (error instanceof PasswordHashError) throw error;
      // Neither provider errors nor user material enter an error message/cause.
      throw new PasswordHashError("crypto_unavailable");
    } finally { active -= 1; }
  }
  return Object.freeze({
    limits: Object.freeze({ maxConcurrent, memoryBudgetBytes, maxmemPerOperationBytes: SCRYPT_V1_MAXMEM_BYTES }),
    async hash(password: string) {
      const bytes = passwordBytes(password);
      try {
        return await admitted(async () => {
          const salt = randomBytes(SCRYPT_V1.saltBytes), key = await derive(bytes, salt);
          try { return ["scrypt", SCRYPT_V1.version, SCRYPT_V1.N, SCRYPT_V1.r, SCRYPT_V1.p, SCRYPT_V1.keyBytes, salt.toString("base64url"), key.toString("base64url")].join("$"); }
          finally { key.fill(0); }
        });
      } finally { bytes.fill(0); }
    },
    async verify(password: string, verifier: unknown) {
      const parsed = parseVerifier(verifier), bytes = passwordBytes(password);
      try {
        return await admitted(async () => {
          const key = await derive(bytes, parsed.salt);
          try { return timingSafeEqual(key, parsed.key); }
          finally { key.fill(0); }
        });
      } finally { bytes.fill(0); parsed.key.fill(0); }
    },
  });
}
