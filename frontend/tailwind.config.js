/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // `hover:` applies only where a real hover exists, so a tap never leaves a
  // control stuck in its hover state.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        // Tab bar, rail and sidebar.
        chrome: "hsl(var(--chrome))",
        // Raised controls: the pill, the segmented track.
        "surface-2": "hsl(var(--surface-2))",
        // The selected state: primary tinted over whatever surface is beneath.
        selected: "hsl(var(--primary) / var(--selected-alpha))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        // Only for a live microphone: the Stop bar, the recording dot, the level trace.
        live: {
          DEFAULT: "hsl(var(--live))",
          foreground: "hsl(var(--live-foreground))",
        },
        warning: "hsl(var(--warning))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      // Display roles only (titles, the recorder timer, empty-state headlines);
      // everything else stays on the system sans.
      fontFamily: {
        display: ['"Literata Variable"', '"Iowan Old Style"', '"Palatino Linotype"', "Palatino", "Georgia", "serif"],
      },
      // Type roles. The display ones (timer to title-2) pair with font-display.
      // lib/utils.ts registers them with tailwind-merge, so cn() keeps a role
      // next to a text colour.
      fontSize: {
        timer: ["3rem", { lineHeight: "3rem", fontWeight: "500" }],
        display: ["1.875rem", { lineHeight: "2.25rem", fontWeight: "500" }],
        "title-1": ["1.75rem", { lineHeight: "2.125rem", fontWeight: "600" }],
        "title-2": ["1.25rem", { lineHeight: "1.625rem", fontWeight: "600" }],
        headline: ["1.0625rem", { lineHeight: "1.375rem", fontWeight: "600" }],
        body: ["1rem", { lineHeight: "1.5rem" }],
        callout: ["0.9375rem", { lineHeight: "1.25rem" }],
        meta: ["0.8125rem", { lineHeight: "1.125rem" }],
        label: ["0.6875rem", { lineHeight: "0.875rem", fontWeight: "500" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        sheet: "1.25rem",
      },
      spacing: {
        13: "3.25rem",
        18: "4.5rem",
      },
      boxShadow: {
        // Floating surfaces (the pill, popovers, sheets, dialogs): one tight shadow, no outline.
        float: "var(--shadow-float)",
      },
      transitionDuration: {
        250: "250ms",
        350: "350ms",
      },
      transitionTimingFunction: {
        smooth: "var(--ease-smooth)",
        exit: "var(--ease-exit)",
        drawer: "var(--ease-drawer)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // The recording dot, only while the mic is live.
        "live-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        // A pushed screen arriving from the trailing edge.
        "push-in": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        // A text state swapping in.
        "rise-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "live-pulse": "live-pulse 1.2s ease-in-out infinite",
        "push-in": "push-in 250ms var(--ease-smooth) both",
        "rise-in": "rise-in 150ms var(--ease-smooth) both",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    // Size classes come from JavaScript (src/lib/sizeClass.ts), published on
    // <html> so the keyboard never flips the layout mid-typing. The default
    // sm/md/lg/xl width screens stay for existing classes.
    require("tailwindcss/plugin")(({ addVariant }) => {
      addVariant("compact", 'html[data-size="compact"] &');
      addVariant("medium", 'html[data-size="medium"] &');
      addVariant("expanded", 'html[data-size="expanded"] &');
      addVariant("wide", ['html[data-size="medium"] &', 'html[data-size="expanded"] &']);
      addVariant("land", "html[data-land] &");
      addVariant("fine", "@media (pointer: fine)");
      addVariant("coarse", "@media (pointer: coarse)");
    }),
  ],
};
