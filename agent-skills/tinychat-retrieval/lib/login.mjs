import { spawn } from 'node:child_process';

const messages = {
  INVALID_AUTH_RESPONSE: 'Supply the complete JSON or base64 JSON authorization response. Truncated or redacted values cannot be used.',
  AUTH_RESPONSE_REJECTED: 'The CLI rejected the authorization response. No successful login is claimed.',
  OPENKEY_PROOF_INVALID: 'The CLI could not verify the signed response for this profile. Supply the complete response for the same profile.',
  OWNER_MISMATCH: 'The approved signing identity differs from the expected owner. Keep the existing profile and choose the intended identity.',
  OPENKEY_SCOPE_MISMATCH: 'The approved space differs from the requested space.',
  OPENKEY_GRANT_BROADENED: 'The signed grant exceeds the installed permission manifest.',
  AUTH_EXPIRED: 'The signed authorization has expired. Browser approval is required again.',
  AUTH_TRANSPORT_TIMEOUT: 'The CLI did not finish the authorization transport within 30 seconds.',
  CLI_UNAVAILABLE: 'TinyCloud CLI could not be started.',
};
const failure = code => Object.assign(new Error(messages[code]), { code });

/** Normalize only encoding/whitespace; the CLI remains the signed-proof verifier. */
export function responseInput(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code) > 1024 * 1024) throw failure('INVALID_AUTH_RESPONSE');
  const text = code.trim();
  let value;
  try {
    value = text.startsWith('{') ? JSON.parse(text) : /^[A-Za-z0-9+/=_-]+$/.test(text) ? JSON.parse(Buffer.from(text, 'base64').toString('utf8')) : null;
  } catch { throw failure('INVALID_AUTH_RESPONSE'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_AUTH_RESPONSE');
  return JSON.stringify(value) + '\n';
}

/** Published CLI --paste supplies both the URL and the verification path; no protocol/key reimplementation. */
export function runLogin(args, { executable = 'tc', input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, '--paste'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
          // URL generation is complete. Paste-mode acquisition has no callback server or saved grant.
          // Stop the waiting process; a later invocation uses the same profile key to verify the response.
          child.kill();
        }
      }
    });
    child.on('close', code => {
      if (authorizationUrl) { finish(null, authorizationUrl); return; }
      if (code === 0 && input !== undefined) { finish(null); return; }
      let detail;
      for (const output of [stdout, stderr]) {
        const start = output.search(/\{\s*"error"\s*:/);
        if (start >= 0) try { detail = JSON.parse(output.slice(start)).error; } catch { /* Never return raw CLI output. */ }
      }
      const resultCode = detail?.code === 'OPENKEY_OWNER_MISMATCH' ? 'OWNER_MISMATCH' : detail?.code;
      finish(failure(Object.hasOwn(messages, resultCode) ? resultCode : 'AUTH_RESPONSE_REJECTED'));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
