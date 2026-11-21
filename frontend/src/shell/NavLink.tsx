// A navigation item's link: a route, or a pinned app that opens its own page in
// a new tab (no delegation, so nothing of One travels with it). In the phone app
// that page opens in the system's in-app browser instead of leaving the app.
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";

import { openLinkInApp } from "@/feed/inAppLink";
import type { NavItem } from "./navItems";

type NavLinkProps = { item: NavItem; to: string; replace: boolean } & Omit<ComponentProps<"a">, "href">;

export function NavLink({ item, to, replace, children, onClick, ...rest }: NavLinkProps) {
  if (item.newTab) {
    return (
      <a href={item.newTab} target="_blank" rel="noopener noreferrer" onClick={(event) => openLinkInApp(item.newTab!, event.nativeEvent, { sheet: false })} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} replace={replace} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}
