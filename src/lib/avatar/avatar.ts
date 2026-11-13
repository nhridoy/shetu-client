/** Background colours for initials avatars; all readable with white text. */
export const AVATAR_COLORS = [
  "#dc2626",
  "#ea580c",
  "#b45309",
  "#15803d",
  "#0f766e",
  "#0369a1",
  "#4338ca",
  "#7c3aed",
  "#a21caf",
  "#be185d",
];

/** Two letters: first + last name initials, a one-word name's first two letters, or the email's. */
export function avatarInitials(name?: string, email?: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const local = (email ?? "").split("@")[0];
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || "?";
}

/** A colour that looks random but is always the same for the same seed (user ID). */
export function avatarColor(seed: string): string {
  // FNV-1a: tiny, stable across runs and platforms.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AVATAR_COLORS[(hash >>> 0) % AVATAR_COLORS.length];
}

/** Gravatar image for an email; `d=404` so a missing Gravatar fails and we fall back to initials. */
export async function gravatarUrl(
  email: string,
  size: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://gravatar.com/avatar/${hex}?s=${size}&d=404`;
}

/** Only absolute https URLs may be used as an image source. */
export function safeImageUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
