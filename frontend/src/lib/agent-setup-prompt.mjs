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

export function buildSetupPrompt({ instructionsUrl }, context) {
  const identity = context.expectedOwner
    ? 'TinyChat supplied an expected owner automatically; retain that comparison during verified login.'
    : 'Let me select my existing signing identity in the browser. Without an expected owner, login verifies the selected identity but does not independently match it to TinyChat.';
  return `Help me use my existing TinyChat meetings through the installed tools and skill. Pack: $HOME/.agents/skills/tinychat-retrieval (Claude Code: $HOME/.claude/skills/tinychat-retrieval); read SKILL.md once if unloaded. If tools are missing, follow ${instructionsUrl} to install the pinned release; in OpenCode use install-opencode.mjs --activate last in a separate native bash call. Activation resumes this chat automatically; no restart or extra continue. Reuse valid saved setup. Use the app JSON below automatically; do not ask for a DID, host or space. ${identity} Save the JSON privately, then call tinychat_setup with configPath set to its absolute path. If login is required, call tinychat_authorize with no arguments and say: “Complete sign-in in the browser, then paste the code here.” The plugin captures and verifies my paste; never reproduce it in a tool argument, command or file. Await the ready receipt. Browser launch is pending approval. If I ask for setup/login only, stop at ready; retrieve meetings only when requested. For meeting requests, use tinychat_meetings action latest with a short operation ID; it returns selected meeting evidence immediately. Read the returned evidence. If nextAction is non-null, follow action next with its explicit chunk; repeat the same input to replay. Run actions sequentially. When nextAction is null, answer directly; no extra completion call is needed. Cite each substantive point with the delivered span ref values. Check named speakers and semantic support against their text; questions, offers and commitments differ. Later evidence is historical, without current remote checks. Report missing dates or an unavailable latest body without substituting an older meeting. Answer: How did my last meeting go? Retain observed-catalog limits. For “export this session,” use tinychat_handoff for a local diagnostic handoff and report its absolute path.\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;
}
