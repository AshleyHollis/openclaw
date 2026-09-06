import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Shared by hook dispatch and admission of competing plugin routes. */
export function normalizeHooksBasePath(value: string | undefined): string {
  const rawPath = normalizeOptionalString(value) || "/hooks";
  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  if (trimmed === "/") throw new Error("hooks.path may not be '/'");
  return trimmed;
}

export function isHooksRequestPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}
