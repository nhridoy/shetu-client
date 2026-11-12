import { useEffect, useState } from "react";
import {
  avatarColor,
  avatarInitials,
  gravatarUrl,
  safeImageUrl,
} from "@/lib/avatar/avatar";

interface AvatarProps {
  /** Stable user ID; picks the initials colour. */
  id: string;
  name?: string;
  email?: string;
  /** Google/GitHub picture from the server. */
  avatarUrl?: string;
  /** Diameter in px. */
  size?: number;
}

/** Provider picture, then Gravatar, then two-letter initials on a per-user colour. */
export function Avatar({ id, name, email, avatarUrl, size = 24 }: AvatarProps) {
  const [gravatar, setGravatar] = useState<string>();
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!email) return;
    let live = true;
    gravatarUrl(email, size * 2)
      .then((url) => live && setGravatar(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [email, size]);

  const src = [safeImageUrl(avatarUrl), gravatar].find(
    (url): url is string => !!url && !failed.has(url),
  );
  const box = { width: size, height: size };

  if (src)
    return (
      <img
        src={src}
        alt=""
        style={box}
        referrerPolicy="no-referrer"
        onError={() => setFailed((prev) => new Set(prev).add(src))}
        className="rounded-full object-cover shrink-0"
      />
    );
  return (
    <span
      aria-hidden="true"
      style={{
        ...box,
        backgroundColor: avatarColor(id),
        fontSize: Math.round(size * 0.4),
      }}
      className="flex items-center justify-center rounded-full shrink-0 font-semibold text-white select-none"
    >
      {avatarInitials(name, email)}
    </span>
  );
}
