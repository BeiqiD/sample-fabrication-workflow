import type { Readable, Writable } from 'node:stream';
import { MAX_PASSWORD_BYTES } from '../auth/passwords';

export class OperatorInputError extends Error {
  constructor() { super('Operator secret input is unavailable.'); this.name = 'OperatorInputError'; }
}
type SecretInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(value: boolean): unknown };

/** Direct operator callers share the stdin contract before any DB/lock I/O. */
export function assertOperatorPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || !password.length || password.length > MAX_PASSWORD_BYTES || /[\r\n\0]/.test(password)) throw new OperatorInputError();
  const bytes = Buffer.from(password, 'utf8');
  try {
    if (bytes.length > MAX_PASSWORD_BYTES || bytes.toString('utf8') !== password) throw new OperatorInputError();
  } finally { bytes.fill(0); }
}

/** A single bounded UTF-8 password is read before installation ownership.
 * Pipes must end after one line (optional LF/CRLF); a genuine TTY uses raw mode
 * without echo. The caller owns the stream; only this reader's byte buffer is
 * erased. Returned transient JS strings remain garbage-collector managed.
 * No argv/environment fallback and no password material enters diagnostics. */
export function readOperatorPassword(input: SecretInput, diagnostics: Writable, options: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  if (!input || !diagnostics || Object.keys(options).some(key => key !== 'timeoutMs')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || input.readableEncoding !== null) {
    return Promise.reject(new OperatorInputError());
  }
  const tty = input.isTTY === true, previousRaw = input.isRaw === true;
  if (tty && typeof input.setRawMode !== 'function') return Promise.reject(new OperatorInputError());
  return new Promise<string>((resolve, reject) => {
    const bytes = Buffer.alloc(MAX_PASSWORD_BYTES + 2); let used = 0, settled = false, enteredRaw = false;
    let promptPending = false, promptRemovalScheduled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = () => finish();
    function removePromptErrorAfterSettlement(): void {
      if (!tty || !settled || promptPending || promptRemovalScheduled) return;
      promptRemovalScheduled = true;
      setImmediate(() => diagnostics.removeListener('error', unavailable));
    }
    function finish(password?: string): void {
      if (settled) return; settled = true;
      clearTimeout(timer); let restored = true;
      try { input.pause(); } catch { restored = false; }
      input.removeListener('data', data); input.removeListener('end', end);
      input.removeListener('error', unavailable); input.removeListener('close', unavailable);
      process.removeListener('SIGINT', unavailable); process.removeListener('SIGTERM', unavailable);
      // Input timeout/signal restores the TTY immediately, but a pending prompt
      // still owns its later callback/error. Remove only after actual callback
      // settlement and its possible nextTick error emission.
      removePromptErrorAfterSettlement();
      if (enteredRaw) { try { input.setRawMode!(previousRaw); } catch { restored = false; } }
      bytes.fill(0);
      if (typeof password === 'string' && restored) resolve(password); else reject(new OperatorInputError());
    }
    function decode(length: number): void {
      if (!length || length > MAX_PASSWORD_BYTES) return finish();
      try {
        const password = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
        assertOperatorPassword(password);
        finish(password);
      } catch { finish(); }
    }
    function end(): void {
      if (tty) return finish();
      let length = used;
      if (length && bytes[length - 1] === 10) { length--; if (length && bytes[length - 1] === 13) length--; }
      decode(length);
    }
    function data(chunk: unknown): void {
      if (!Buffer.isBuffer(chunk)) return finish();
      if (!tty) {
        if (used + chunk.length > bytes.length) return finish();
        chunk.copy(bytes, used); used += chunk.length; return;
      }
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) return finish(); // Raw Ctrl-C/Ctrl-D.
        if (byte === 10 || byte === 13) return decode(used);
        if (byte === 8 || byte === 127) {
          // Erase the final UTF-8 codepoint, including split multibyte input.
          if (used) { used--; while (used && (bytes[used] & 0xc0) === 0x80) used--; bytes.fill(0, used); }
          continue;
        }
        // Raw terminal escape/control sequences are not password text.
        if (byte < 32 || used >= MAX_PASSWORD_BYTES) return finish();
        bytes[used++] = byte;
      }
    }
    try {
      input.pause();
      if (tty) { diagnostics.on('error', unavailable); enteredRaw = true; input.setRawMode!(true); }
      input.on('data', data); input.once('end', end); input.once('error', unavailable); input.once('close', unavailable);
      process.once('SIGINT', unavailable); process.once('SIGTERM', unavailable);
      timer = setTimeout(unavailable, timeoutMs);
      if (tty) {
        promptPending = true;
        try { diagnostics.write('Password: ', error => {
          promptPending = false;
          if (error) finish(); else if (!settled) input.resume();
          removePromptErrorAfterSettlement();
        }); }
        catch { promptPending = false; throw new OperatorInputError(); }
      } else input.resume();
    } catch { finish(); }
  });
}
