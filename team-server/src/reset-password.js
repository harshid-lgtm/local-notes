// Set a new password for an account, from the server's terminal.
//   node src/reset-password.js you@example.com
// Uses DATA_DIR if set; otherwise finds team.db next to the server.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { openDb } from './db.js';
import { hashPassword } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [process.env.DATA_DIR, path.join(here, '..', 'data'), path.join(here, '..', '..', 'data')].filter(Boolean);
const dataDir = candidates.find((d) => fs.existsSync(path.join(d, 'team.db')));
const email = String(process.argv[2] || '').trim().toLowerCase();

if (!email) { console.error('Usage: node src/reset-password.js you@example.com'); process.exit(1); }
if (!dataDir) { console.error(`Couldn't find team.db. Set DATA_DIR to the server's data folder.`); process.exit(1); }

const db = openDb(dataDir);
const user = db.get('SELECT id, name, email FROM users WHERE lower(email) = ?', email);
if (!user) {
  console.error(`No account with the email ${email}. Accounts on this server:`);
  for (const u of db.all('SELECT name, email FROM users ORDER BY created_at')) console.error(`  ${u.name} <${u.email}>`);
  process.exit(1);
}

// Read lines without echoing what's typed (one reader, so piped input works too).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
rl.setPrompt(''); // line redraws (e.g. after backspace) then contain only the hidden input, which we drop
const lines = rl[Symbol.asyncIterator]();
let prompting = '';
rl._writeToOutput = (s) => { if (s === prompting) rl.output.write(s); else if (/[\r\n]/.test(s)) rl.output.write('\n'); };
async function ask(prompt) {
  prompting = prompt;
  rl.output.write(prompt);
  const { value = '' } = await lines.next();
  if (!process.stdin.isTTY) rl.output.write('\n');
  return value;
}

const pw = await ask(`New password for ${user.name} <${user.email}>: `);
if (pw.length < 8) { rl.close(); console.error('Passwords need at least 8 characters. Nothing changed.'); process.exit(1); }
const again = await ask('Type it again: ');
if (pw !== again) { rl.close(); console.error('The passwords didn’t match. Nothing changed.'); process.exit(1); }

db.run('UPDATE users SET pw = ? WHERE id = ?', hashPassword(pw), user.id);
db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
rl.close();
console.log(`Password updated for ${user.email}. Sign in with the new password (other devices are signed out).`);
