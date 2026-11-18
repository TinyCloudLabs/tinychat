// Hosts whose image requests are not read by someone who wants the data in the address. Such an image does not use a reply's
// budget (lib/imageBudget.ts). The address filter (lib/imageUrlFilter.ts) judges an address on these hosts like any other.

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

// Other operators' image hosts, each there because the operator's request logs are not readable by whoever wrote the reply
// [INFERENCE for both: from how each service is documented to work, not tested].
const TRUSTED_IMAGE_HOSTS = [
  "i.imgur.com", // Imgur's image CDN; anyone can upload an image, nobody gets request logs.
  "avatars.githubusercontent.com", // GitHub's avatar service only; not raw.githubusercontent.com, which serves arbitrary repo files.
  // Left off on purpose: upload.wikimedia.org (Wikimedia publishes per-file request counts, so which images were opened is public
  // a day later), res.cloudinary.com (any customer reads their own cloud's delivery logs), img.shields.io (its
  // /endpoint?url= and dynamic badges make shields.io fetch an address of the attacker's choosing) and images.unsplash.com
  // (imgix-backed: mark64=/blend64= take a base64 address that no filter can read cheaply).
];

export function isAllowlistedImageHost(hostname: string): boolean {
  return OWN_IMAGE_HOSTS.includes(hostname) || TRUSTED_IMAGE_HOSTS.includes(hostname);
}

// Image CDNs that name files by long opaque ids and give whoever put the file there no request log, so a long id in the
// address tells nobody anything [INFERENCE for each: from how the service is documented to work, not tested]. For these the
// address filter does not count opaque characters, length or parameters; an address inside the address (imgix `mark=`,
// `mark64=`), credentials and the rest are judged as on any host. Matched exactly or by the listed suffix: a broader match
// would take in hosts that run user code (script.googleusercontent.com).
const OPAQUE_ID_HOSTS =
  /^(?:(?:lh[3-6]|blogger)\.googleusercontent\.com|(?:[a-z0-9-]+\.)?ggpht\.com|encrypted-tbn[0-3]\.gstatic\.com|i[0-9]?\.ytimg\.com|img\.youtube\.com|(?:images|plus)\.unsplash\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.fbcdn\.net|[a-z0-9-]+(?:\.[a-z0-9-]+)?\.cdninstagram\.com|media\.licdn\.com|m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|(?:media[0-9]?|i)\.giphy\.com|a[0-9]\.muscache\.com)$/;

export function servesOpaqueIds(hostname: string): boolean {
  return OPAQUE_ID_HOSTS.test(hostname);
}
