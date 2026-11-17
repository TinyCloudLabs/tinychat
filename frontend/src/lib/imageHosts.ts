// Hosts whose image requests are not read by someone who wants the data in the address. Such an image does not use a reply's
// budget (lib/imageBudget.ts) and is not asked about for its host name (lib/imageUrlFilter.ts); the rest of the address is
// still checked, including an address inside it (a redirect or onward fetch).

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
// [INFERENCE for all three: from how each service is documented to work, not tested].
const TRUSTED_IMAGE_HOSTS = [
  "i.imgur.com", // Imgur's image CDN; anyone can upload an image, nobody gets request logs.
  "avatars.githubusercontent.com", // GitHub's avatar service only; not raw.githubusercontent.com, which serves arbitrary repo files.
  "upload.wikimedia.org", // Wikimedia's media store; request logs are the foundation's.
  // Left off on purpose: res.cloudinary.com (any customer reads their own cloud's delivery logs), img.shields.io (its
  // /endpoint?url= and dynamic badges make shields.io fetch an address of the attacker's choosing) and images.unsplash.com
  // (imgix-backed: mark64=/blend64= take a base64 address that no filter can read cheaply).
];

export function isAllowlistedImageHost(hostname: string): boolean {
  return OWN_IMAGE_HOSTS.includes(hostname) || TRUSTED_IMAGE_HOSTS.includes(hostname);
}
