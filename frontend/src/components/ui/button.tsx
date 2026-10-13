import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// A press answers at once: the colour deepens and the button scales to 0.97
// over 100ms (no scale with reduced motion), in place of the grey iOS tap flash.
const buttonVariants = cva(
  "tap-transparent inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,opacity,transform] duration-100 active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
        // Its edge (--input, 3:1) defines it; it takes the surface it sits on.
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground active:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
        ghost: "hover:bg-accent hover:text-accent-foreground active:bg-accent",
        link: "text-primary underline-offset-4 hover:underline active:scale-100 active:opacity-70",
        // Stop and the other controls of a live microphone, and nothing else.
        live: "bg-live text-live-foreground hover:bg-live/90 active:bg-live/80",
      },
      // Heights follow the pointer (index.css --tc-control-height*): 44px on
      // touch; 36px (sm 32px) with a mouse. One h-* or size-* class per size, so
      // a caller's own height still replaces it through cn().
      size: {
        default: "h-[var(--tc-control-height)] px-4 py-2",
        sm: "h-[var(--tc-control-height-sm)] rounded-md px-3 text-xs",
        lg: "h-12 rounded-md px-6",
        icon: "size-[var(--tc-control-height)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
