import { parseIdentityOperatorCommand, executeIdentityOperator } from './identity-operator';
import { readOperatorPassword } from './operator-password';

const USAGE = 'Usage: local-identity <bootstrap|restore-administrator|reset-password> --database <canonical-private-db> <--username name|--principal local_UUID> [--filesystem-root-owner-uid UID]\nPassword: one UTF-8 line through stdin, or hidden terminal input. Database and its empty private .writer-lock file must already exist.\n';
async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') { process.stdout.write(USAGE); return; }
  const command = parseIdentityOperatorCommand(process.argv.slice(2));
  let password: string | undefined;
  try {
    // Complete secret input before acquiring the OS writer lease.
    password = await readOperatorPassword(process.stdin, process.stderr);
    if (process.stdin.isTTY) process.stderr.write('\n');
    await executeIdentityOperator(command, password);
    process.stdout.write('Offline identity operation completed.\n');
  } finally { password = undefined; }
}
void main().catch(() => {
  // No raw provider error/cause, argument, path, principal, password or token.
  process.stderr.write('Offline identity operation unavailable.\n'); process.exitCode = 1;
});
