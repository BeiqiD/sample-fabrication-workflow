import { LocalV28MaintenanceCaptureError, parseLocalV28MaintenanceCaptureCommandCandidate,
  type LocalV28MaintenanceCaptureCommand } from './local-v28-maintenance-capture-operator-candidate.ts';

/** Explicit public selection only. The existing parser privately issues the
 * original stopped-capture token; this wrapper supplies no actor or authority. */
export function parseV28MaintenanceCaptureCommand(argv: readonly string[]): LocalV28MaintenanceCaptureCommand {
  if (!Array.isArray(argv) || ![9, 11].includes(argv.length) || argv[0] !== 'capture-local-backup'
    || argv.some(value => typeof value !== 'string' || !value || value.length > 4000 || value.includes('\0')))
    throw new LocalV28MaintenanceCaptureError();
  const original = ['capture'];
  let selected = false;
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]!, value = argv[index + 1]!;
    if (name === '--runtime-profile') {
      if (selected || value !== 'v28') throw new LocalV28MaintenanceCaptureError();
      selected = true;
    } else original.push(name, value);
  }
  if (!selected) throw new LocalV28MaintenanceCaptureError();
  return parseLocalV28MaintenanceCaptureCommandCandidate(original);
}
