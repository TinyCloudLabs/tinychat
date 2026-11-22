// Run by the service through the sandbox host's exec channel: posts this launch's bridge token, gateway token,
// gateway address, model, the bot's role and OMP's config (from its environment; the config base64, so it stays one
// line) to the bridge on the sandbox's loopback.

const port = Number(process.env.ARM_PORT ?? 7071);
const body = JSON.stringify({
  bridgeToken: process.env.BOT_BRIDGE_TOKEN,
  gatewayToken: process.env.BOT_TOKEN,
  gatewayUrl: process.env.BOT_GATEWAY_URL,
  model: process.env.BOT_MODEL,
  role: process.env.BOT_ROLE,
  ompConfig: process.env.BOT_OMP_CONFIG === undefined ? undefined : Buffer.from(process.env.BOT_OMP_CONFIG, "base64").toString("utf8"),
});
// The bridge may still be starting with a freshly woken sandbox.
for (let attempt = 0; attempt < 100; attempt++) {
  const response = await fetch(`http://127.0.0.1:${port}/arm`, { method: "POST", body }).catch(() => undefined);
  if (response) process.exit(response.status === 204 ? 0 : 1);
  await Bun.sleep(100);
}
process.exit(2);

export {};
