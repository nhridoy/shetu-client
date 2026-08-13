import {
  Apple,
  Archlinux,
  Aws,
  CentosIcon,
  Debian,
  Elementary,
  Fedora,
  Freebsd,
  LinuxMint,
  LinuxTux,
  Manjaro,
  MicrosoftWindowsIcon,
  Oracle,
  RedhatIcon,
  RockyLinuxIcon,
  Suse,
  Ubuntu,
} from "@dev.icons/react";
import type { FC, SVGProps } from "react";
import PlaceholderOsIcon from "@/components/icons/os/PlaceholderOsIcon";

export interface OsMeta {
  name: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
}

export const OS_META: Record<string, OsMeta> = {
  ubuntu: { name: "Ubuntu", Icon: Ubuntu },
  debian: { name: "Debian", Icon: Debian },
  fedora: { name: "Fedora", Icon: Fedora },
  arch: { name: "Arch Linux", Icon: Archlinux },
  manjaro: { name: "Manjaro", Icon: Manjaro },
  linuxmint: { name: "Linux Mint", Icon: LinuxMint },
  alpine: { name: "Alpine Linux", Icon: LinuxTux },
  centos: { name: "CentOS", Icon: CentosIcon },
  rocky: { name: "Rocky Linux", Icon: RockyLinuxIcon },
  rhel: { name: "Red Hat Enterprise Linux", Icon: RedhatIcon },
  amazon: { name: "Amazon Linux", Icon: Aws },
  opensuse: { name: "openSUSE", Icon: LinuxTux },
  sles: { name: "SUSE Linux Enterprise", Icon: Suse },
  nixos: { name: "NixOS", Icon: LinuxTux },
  gentoo: { name: "Gentoo", Icon: LinuxTux },
  elementary: { name: "elementary OS", Icon: Elementary },
  oracle: { name: "Oracle Linux", Icon: Oracle },
  darwin: { name: "macOS", Icon: Apple },
  windows: { name: "Windows", Icon: MicrosoftWindowsIcon },
  bsd: { name: "BSD", Icon: Freebsd },
  kali: { name: "Kali Linux", Icon: LinuxTux },
  linux: { name: "Linux", Icon: LinuxTux },
};

export function osMeta(os?: string): OsMeta {
  const key = os?.trim().toLowerCase();
  return (
    (key && OS_META[key]) || {
      name: os?.trim() ? os : "Unknown",
      Icon: PlaceholderOsIcon,
    }
  );
}
