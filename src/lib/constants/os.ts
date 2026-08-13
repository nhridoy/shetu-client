import type { FC } from "react";
import AppleIcon from "@/components/icons/os/AppleIcon";
import ArchLinuxIcon from "@/components/icons/os/ArchLinuxIcon";
import CentosIcon from "@/components/icons/os/CentosIcon";
import DebianIcon from "@/components/icons/os/DebianIcon";
import FedoraIcon from "@/components/icons/os/FedoraIcon";
import GentooIcon from "@/components/icons/os/GentooIcon";
import LinuxMintIcon from "@/components/icons/os/LinuxMintIcon";
import OpensuseIcon from "@/components/icons/os/OpensuseIcon";
import PlaceholderOsIcon from "@/components/icons/os/PlaceholderOsIcon";
import RedHatIcon from "@/components/icons/os/RedHatIcon";
import UbuntuIcon from "@/components/icons/os/UbuntuIcon";
import WindowsIcon from "@/components/icons/os/WindowsIcon";

export interface OsMeta {
  name: string;
  Icon: FC<{ className?: string }>;
}

export const OS_META: Record<string, OsMeta> = {
  ubuntu: { name: "Ubuntu", Icon: UbuntuIcon },
  debian: { name: "Debian", Icon: DebianIcon },
  fedora: { name: "Fedora", Icon: FedoraIcon },
  arch: { name: "Arch Linux", Icon: ArchLinuxIcon },
  manjaro: { name: "Manjaro", Icon: PlaceholderOsIcon },
  linuxmint: { name: "Linux Mint", Icon: LinuxMintIcon },
  pop: { name: "Pop!_OS", Icon: PlaceholderOsIcon },
  kali: { name: "Kali Linux", Icon: PlaceholderOsIcon },
  alpine: { name: "Alpine Linux", Icon: PlaceholderOsIcon },
  centos: { name: "CentOS", Icon: CentosIcon },
  rocky: { name: "Rocky Linux", Icon: PlaceholderOsIcon },
  rhel: { name: "Red Hat Enterprise Linux", Icon: RedHatIcon },
  amazon: { name: "Amazon Linux", Icon: PlaceholderOsIcon },
  opensuse: { name: "openSUSE", Icon: OpensuseIcon },
  sles: { name: "SUSE Linux Enterprise", Icon: PlaceholderOsIcon },
  nixos: { name: "NixOS", Icon: PlaceholderOsIcon },
  gentoo: { name: "Gentoo", Icon: GentooIcon },
  zorin: { name: "Zorin OS", Icon: PlaceholderOsIcon },
  elementary: { name: "elementary OS", Icon: PlaceholderOsIcon },
  oracle: { name: "Oracle Linux", Icon: PlaceholderOsIcon },
  darwin: { name: "macOS", Icon: AppleIcon },
  windows: { name: "Windows", Icon: WindowsIcon },
  bsd: { name: "BSD", Icon: PlaceholderOsIcon },
  solaris: { name: "Solaris", Icon: PlaceholderOsIcon },
  linux: { name: "Linux", Icon: PlaceholderOsIcon },
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
