import { osMeta } from "@/lib/constants/os";

export function OsIcon({ os, className }: { os?: string; className?: string }) {
  const { Icon } = osMeta(os);
  return <Icon className={className} />;
}
