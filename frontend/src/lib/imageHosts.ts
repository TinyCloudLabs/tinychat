// Hosts whose image requests are not read by a third party who wants the data in the address. Such an image does not use a
// reply's budget (lib/imageBudget.ts) and is not asked about for its host name (lib/imageUrlFilter.ts); the rest of the
// address is still checked, since a path or query can carry text to a redirect.

// Ours: the request log is ours. Matched on a dot boundary, subdomains included ("evil-tinycloud.one" is not ours).
const OWN_DOMAINS = ["tinycloud.one", "tinycloud.chat", "tinycloud.xyz"];

// Other operators' image hosts, matched exactly (never their subdomains), each there because the operator's request logs are
// not readable by whoever wrote the reply [INFERENCE for all five: from how each service is documented to work, not tested].
const TRUSTED_IMAGE_HOSTS = [
  "i.imgur.com", // Imgur's image CDN; anyone can upload an image, nobody gets request logs.
  "avatars.githubusercontent.com", // GitHub's avatar service only; not raw.githubusercontent.com, which serves arbitrary repo files.
  "upload.wikimedia.org", // Wikimedia's media store; request logs are the foundation's.
  "images.unsplash.com", // Unsplash's photo CDN.
  "img.shields.io", // Badge renderer; it draws text from the address but logs belong to the service.
  // Left off on purpose: res.cloudinary.com. Any Cloudinary customer can serve from their own cloud and read its delivery logs.
];

export function isAllowlistedImageHost(hostname: string): boolean {
  return (
    OWN_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)) ||
    TRUSTED_IMAGE_HOSTS.includes(hostname)
  );
}
