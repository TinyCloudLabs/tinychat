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
  AUTH_TRANSPORT_UNAVAILABLE: 'Additional OpenKey grants need the system script and stty PTY transport on Linux or macOS.',
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

/** Keep proof handling in the official CLI. Login has --paste; request --grant
 * only reads private stdin when stdout is a TTY, so use a non-recording PTY.
 */
export function runLogin(args, { executable = 'tc', input } = {}) {
  return new Promise((resolve, reject) => {
    const grant = args.includes('request') && args.includes('--grant');
    if (grant && !['linux', 'darwin'].includes(process.platform)) { reject(failure('AUTH_TRANSPORT_UNAVAILABLE')); return; }
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = grant ? `stty -echo -icanon min 1 time 0 || exit 125; exec ${[executable, ...args, '--no-popup'].map(quote).join(' ')}` : null;
    const child = grant
      ? spawn('script', process.platform === 'linux' ? ['-qefc', command, '/dev/null'] : ['-q', '/dev/null', '/bin/sh', '-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(executable, [...args, '--paste'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', authorizationUrl, settled = false, sent = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(failure('AUTH_TRANSPORT_TIMEOUT')), 30000);
    child.on('error', () => finish(failure(grant ? 'AUTH_TRANSPORT_UNAVAILABLE' : 'CLI_UNAVAILABLE')));
    child.stdin.on('error', () => {}); // An early CLI rejection may close stdin; its exit below is authoritative.
    function receive(chunk, stream) {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) { finish(failure('AUTH_RESPONSE_REJECTED')); return; }
      const output = grant ? stdout : stderr;
      if (grant && output.includes('Approve local-key delegation? [y/N]')) { finish(failure('AUTH_TRANSPORT_UNAVAILABLE')); return; }
      if (input === undefined && !authorizationUrl) {
        const match = output.match(/Open this URL in a browser to authenticate:\s*(https?:\/\/[^\s]+)\s/);
        if (match) {
          authorizationUrl = match[1];
          // No consent waiter survives URL acquisition. Verification invokes the
          // same official command with the same profile key and frozen manifest.
          child.kill();
        }
      } else if (grant && input !== undefined && !sent && output.includes('paste the delegation code here:')) {
        sent = true;
        child.stdin.write(input);
      }
    }
    child.stdout.on('data', chunk => receive(chunk, 'stdout'));
    child.stderr.on('data', chunk => receive(chunk, 'stderr'));
    child.on('close', code => {
      if (grant && code === 125) { finish(failure('AUTH_TRANSPORT_UNAVAILABLE')); return; }
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
    if (input !== undefined && !grant) child.stdin.end(input);
  });
}
