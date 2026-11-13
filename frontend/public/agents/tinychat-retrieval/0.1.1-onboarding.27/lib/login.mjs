import { spawn } from 'node:child_process';
import { defaultTc } from './retrieval.mjs';

const messages = {
  INVALID_AUTH_RESPONSE: 'Send the code OpenKey showed, exactly as shown.',
  AUTH_RESPONSE_REJECTED: 'The CLI did not accept the code. Each code works once and expires after 5 minutes: run authorize again and send the new link.',
  OPENKEY_PROOF_INVALID: 'The CLI could not verify the code for this profile. Run authorize again and send the new link.',
  OWNER_MISMATCH: 'The approved signing identity differs from the expected owner. Approve with the account you use for TinyChat.',
  OPENKEY_SCOPE_MISMATCH: 'The approved space differs from the requested space.',
  OPENKEY_GRANT_BROADENED: 'The signed grant exceeds the requested TinyChat access.',
  AUTH_EXPIRED: 'The approval has expired. Run authorize again and send the new link.',
  AUTH_TRANSPORT_TIMEOUT: 'The CLI did not finish the approval within 30 seconds.',
  CLI_UNAVAILABLE: 'TinyCloud CLI not found: run https://agents.tinycloud.xyz/onboarding or set TC_BIN.',
};
const failure = code => Object.assign(new Error(messages[code]), { code });

/** Normalize only encoding/whitespace; the CLI remains the signed-proof verifier. */
export function responseInput(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code) > 1024 * 1024) throw failure('INVALID_AUTH_RESPONSE');
  const text = code.trim();
  // OpenKey's short code (like ABCD-EFGH): the CLI looks it up and checks it against this profile's key.
  if (/^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(text)) return text + '\n';
  let value;
  try {
    value = text.startsWith('{') ? JSON.parse(text) : /^[A-Za-z0-9+/=_-]+$/.test(text) ? JSON.parse(Buffer.from(text, 'base64').toString('utf8')) : null;
  } catch { throw failure('INVALID_AUTH_RESPONSE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_AUTH_RESPONSE');
  return JSON.stringify(value) + '\n';
}

/**
 * Runs `auth request ... --grant --paste`. Without input it returns the OpenKey URL the CLI prints,
 * or undefined when the profile already has the access. With input, the code goes to the CLI's stdin.
 */
export function runGrant(args, { executable = defaultTc(), input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', authorizationUrl, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(failure('AUTH_TRANSPORT_TIMEOUT')), 30000);
    child.on('error', () => finish(failure('CLI_UNAVAILABLE')));
    child.stdin.on('error', () => {}); // An early CLI rejection may close stdin; its exit below is authoritative.
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) finish(failure('AUTH_RESPONSE_REJECTED')); });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) { finish(failure('AUTH_RESPONSE_REJECTED')); return; }
      if (input === undefined && !authorizationUrl) {
        const match = stderr.match(/Open this URL in a browser to authenticate:\s*\n\s*(https?:\/\/[^\s]+)\s*\n/);
        if (match) {
          authorizationUrl = match[1];
          // Paste mode keeps no callback server or saved grant. Stop the waiting process;
          // a later invocation with the code on stdin uses the same profile key.
          child.kill();
        }
      }
    });
    child.on('close', code => {
      if (authorizationUrl) { finish(null, authorizationUrl); return; }
      if (code === 0) { finish(null); return; }
      let detail;
      for (const output of [stdout, stderr]) {
        const start = output.search(/\{\s*"error"\s*:/);
        if (start >= 0) try { detail = JSON.parse(output.slice(start)).error; } catch { /* Never return raw CLI output. */ }
      }
      const resultCode = detail?.code === 'OPENKEY_OWNER_MISMATCH' ? 'OWNER_MISMATCH' : detail?.code;
      finish(failure(Object.hasOwn(messages, resultCode) ? resultCode : 'AUTH_RESPONSE_REJECTED'));
    });
    // No code: empty stdin, like `< /dev/null`, so the CLI only prints the link.
    child.stdin.end(input);
  });
}
