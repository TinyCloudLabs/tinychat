import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The names tailwind.config.js adds. Unregistered, tailwind-merge reads a type
// role such as `text-body` as a text colour and drops it next to
// `text-muted-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["timer", "display", "title-1", "title-2", "headline", "body", "callout", "meta", "label"],
      shadow: ["float"],
      ease: ["smooth", "exit", "drawer"],
      radius: ["sheet"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
