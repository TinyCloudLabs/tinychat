const HOME_NAME = "TinyCloud Home";
const HOME_DESCRIPTION = "Updates and decisions from your agents, in your TinyCloud space.";

/** index.html for the Home site build (TC-2387): the installed-app and description tags carry the Home name. */
export function homeSiteIndexHtml(html: string): string {
  return html
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${HOME_NAME}$2`)
    .replace(/(<meta name="application-name" content=")[^"]*(")/, `$1${HOME_NAME}$2`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${HOME_DESCRIPTION}$2`);
}
