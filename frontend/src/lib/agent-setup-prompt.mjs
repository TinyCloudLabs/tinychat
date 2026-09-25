/** App-owned setup metadata. These identifiers are configuration, not credentials. */
export function createSetupContext(hosts, expectedOwner) {
  if (!Array.isArray(hosts) || hosts.length !== 1) {
    throw new Error('TinyChat setup configuration needs exactly one data host. Contact this deployment’s administrator.');
  }
  let url;
  try {
    url = new URL(hosts[0]);
  } catch {
    throw new Error('TinyChat setup configuration has an invalid data host. Contact this deployment’s administrator.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('TinyChat setup configuration has an invalid data host. Contact this deployment’s administrator.');
  }
  const context = { schemaVersion: 1, host: url.href.replace(/\/$/, ''), space: 'applications' };
  if (expectedOwner != null) {
    if (typeof expectedOwner !== 'string' || !/^did:pkh:eip155:[1-9][0-9]*:0x[a-fA-F0-9]{40}$/.test(expectedOwner)) {
      throw new Error('TinyChat setup configuration has an invalid signing identity. Sign in again before copying the prompt.');
    }
    context.expectedOwner = expectedOwner;
  }
  return context;
}

export function buildSetupPrompt({ instructionsUrl }) {
  return `How did my last meeting go? Check TinyCloud: ${instructionsUrl}`;
}
