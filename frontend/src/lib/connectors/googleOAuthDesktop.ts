import { invoke } from "@tauri-apps/api/core";

const DESKTOP_TOKEN_PREFIX = "exo-google-desktop-v1:";

export function encodeDesktopRefreshToken(token: string): string {
  return `${DESKTOP_TOKEN_PREFIX}${token}`;
}

export function googleRefreshGrant(stored: string): { refreshToken: string; client?: "desktop" } {
  return stored.startsWith(DESKTOP_TOKEN_PREFIX)
    ? { refreshToken: stored.slice(DESKTOP_TOKEN_PREFIX.length), client: "desktop" }
    : { refreshToken: stored };
}

/** Rust binds the port first; only then do we obtain and open Google's URL. */
export async function startDesktopGoogleOAuth(input: {
  backendUrl: string;
  state: string;
  challenge: string;
  onRedirectUri: (uri: string) => void;
}): Promise<string> {
  const redirectUri = await invoke<string>("google_oauth_listen", { state: input.state });
  input.onRedirectUri(redirectUri);
  try {
    const query = new URLSearchParams({ state: input.state, challenge: input.challenge, redirectUri });
    const response = await fetch(`${input.backendUrl}/api/connectors/google/oauth/desktop/start?${query}`);
    if (!response.ok) {
      if (response.status === 503) throw new Error("Google desktop sign-in needs a Desktop OAuth client configuration.");
      throw new Error("Could not start Google sign-in.");
    }
    const body = await response.json() as { authorizationUrl?: unknown };
    if (typeof body.authorizationUrl !== "string") throw new Error("Invalid Google sign-in response.");
    await invoke("google_oauth_open_browser", { url: body.authorizationUrl });
    return await invoke<string>("google_oauth_wait", { state: input.state });
  } catch (error) {
    await invoke("google_oauth_cancel").catch(() => undefined);
    throw error;
  }
}

export function cancelDesktopGoogleOAuth(): void {
  void invoke("google_oauth_cancel").catch(() => undefined);
}
