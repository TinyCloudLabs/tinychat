// Hosts whose image requests are not read by someone who wants the data in the address. Such an image uses only the floor
// of a reply's budget (lib/imageBudget.ts). The address filter (lib/imageUrlFilter.ts) judges an address on these hosts
// like any other.

// Ours, listed exactly: each is a host that serves our own pages or media, so the request log is ours. Other subdomains of our
// domains are not listed, because some serve user-published content; they are judged like any other host.
const OWN_IMAGE_HOSTS = [
  "tinycloud.one",
  "www.tinycloud.one",
  "app.tinycloud.one",
  "tinycloud.chat",
  "www.tinycloud.chat",
  "tinycloud.xyz",
  "node.tinycloud.xyz",
];

// Other operators' image hosts whose request logs are not readable by whoever wrote the reply (from each service's
// documentation).
const TRUSTED_IMAGE_HOSTS = [
  "i.imgur.com", // Imgur's image CDN.
  "avatars.githubusercontent.com", // GitHub's avatar service only; not raw.githubusercontent.com.
  // Other popular image hosts are left off on purpose (TC-3144).
];

export function isAllowlistedImageHost(hostname: string): boolean {
  return OWN_IMAGE_HOSTS.includes(hostname) || TRUSTED_IMAGE_HOSTS.includes(hostname);
}

// Image CDNs that name files by long opaque ids (from each service's documentation). For these the address filter does not
// count opaque characters, length or parameters; an address inside the address, credentials and the rest are judged as on
// any host. Matched exactly or by the listed suffix, never more broadly.
const OPAQUE_ID_HOSTS =
  /^(?:(?:lh[3-6]|blogger)\.googleusercontent\.com|(?:[a-z0-9-]+\.)?ggpht\.com|encrypted-tbn[0-3]\.gstatic\.com|i[0-9]?\.ytimg\.com|img\.youtube\.com|(?:images|plus)\.unsplash\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.fbcdn\.net|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.cdninstagram\.com|media\.licdn\.com|m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|(?:media[0-9]?|i)\.giphy\.com|a[0-9]\.muscache\.com)$/;

export function servesOpaqueIds(hostname: string): boolean {
  return OPAQUE_ID_HOSTS.test(hostname);
}
