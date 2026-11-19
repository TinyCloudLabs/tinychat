import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Keep the CLI's URL opaque: neither the model nor a shell rebuilds its query. */
export async function deliverApproval(authorizationUrl, { mode = 'browser' } = {}) {
  if (!['browser', 'file'].includes(mode)) throw new Error('Unsupported approval delivery mode.');
  const directory = await mkdtemp(join(tmpdir(), 'tinychat-approval-'));
  const artifactPath = join(directory, 'approval.html');
  await writeFile(artifactPath, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Approve TinyChat access</title>
<h1>Approve TinyChat access</h1>
<p>Select your existing signing identity in OpenKey, review access, then return the complete response to your agent.</p>
<p><a rel="noreferrer" href="${escapeHtml(authorizationUrl)}">Continue to OpenKey</a></p>
<p>This file does not contain an approved grant. Keep it while sign-in is pending; delete it after login completes or you cancel. Opening it does not complete login.</p></html>
`, { mode: 0o600 });
  const delivery = {
    mode, status: 'file-created', artifactPath,
    lifetime: 'Available until you delete this file or the operating system clears its temporary directory. It is not a public or hosted link.',
    instructions: (mode === 'file'
      ? 'Open delivery.artifactPath on your own machine. If the helper runs on a remote machine, download or transfer the complete file through your trusted client file transfer, then open it locally. '
      : 'Open delivery.artifactPath locally. ') +
      'Click Continue to OpenKey, complete sign-in in the browser, then paste the code here. Keep this operation’s approval file while sign-in is pending. Do not read out or reconstruct the embedded URL. Delete only this operation’s approval file and its empty directory after login completes or you cancel.',
  };
  if (mode === 'file') return delivery;
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  const launched = executable && await new Promise(resolve => {
    // Ignore opener output: it may echo the complete URL. No shell interpolation.
    const child = spawn(executable, [authorizationUrl], { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
  if (!launched) throw Object.assign(new Error('Browser launch failed. Open delivery.artifactPath locally and complete sign-in, then paste the code here.'), { code: 'BROWSER_OPEN_FAILED', delivery });
  return { ...delivery, status: 'launch-requested', instructions: 'Complete sign-in in the browser, then paste the code here.' };
}
