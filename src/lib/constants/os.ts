import type { FC, SVGProps } from "react";
import {
  Alpinejs as AlpinejsIcon,
  Archlinux as ArchlinuxIcon,
  Centos as CentosIcon,
  Debian as DebianIcon,
  Elementary as ElementaryIcon,
  Fedora as FedoraIcon,
  Freebsd as FreebsdIcon,
  LinuxMint as LinuxMintIcon,
  MacOS as MacOSIcon,
  Manjaro as ManjaroIcon,
  MicrosoftWindows as WindowsIcon,
  Oracle as OracleIcon,
  Redhat as RedhatIcon,
  RockyLinux as RockyLinuxIcon,
  Suse as SuseIcon,
  Ubuntu as UbuntuIcon,
  ZorinOs as ZorinOsIcon,
} from "@dev.icons/react";
import PlaceholderOsIcon from "@/components/icons/os/PlaceholderOsIcon";

export interface OsMeta {
  name: string;
  Icon: FC<SVGProps<SVGSVGElement>>;
}

export const OS_META: Record<string, OsMeta> = {
  ubuntu: { name: "Ubuntu", Icon: UbuntuIcon },
  debian: { name: "Debian", Icon: DebianIcon },
  fedora: { name: "Fedora", Icon: FedoraIcon },
  arch: { name: "Arch Linux", Icon: ArchlinuxIcon },
  manjaro: { name: "Manjaro", Icon: ManjaroIcon },
  linuxmint: { name: "Linux Mint", Icon: LinuxMintIcon },
  pop: { name: "Pop!_OS", Icon: PlaceholderOsIcon },
  kali: { name: "Kali Linux", Icon: PlaceholderOsIcon },
  alpine: { name: "Alpine Linux", Icon: AlpinejsIcon },
  centos: { name: "CentOS", Icon: CentosIcon },
  rocky: { name: "Rocky Linux", Icon: RockyLinuxIcon },
  rhel: { name: "Red Hat Enterprise Linux", Icon: RedhatIcon },
  amazon: { name: "Amazon Linux", Icon: PlaceholderOsIcon },
  opensuse: { name: "openSUSE", Icon: PlaceholderOsIcon },
  sles: { name: "SUSE Linux Enterprise", Icon: SuseIcon },
  nixos: { name: "NixOS", Icon: PlaceholderOsIcon },
  gentoo: { name: "Gentoo", Icon: PlaceholderOsIcon },
  zorin: { name: "Zorin OS", Icon: ZorinOsIcon },
  elementary: { name: "elementary OS", Icon: ElementaryIcon },
  oracle: { name: "Oracle Linux", Icon: OracleIcon },
  darwin: { name: "macOS", Icon: MacOSIcon },
  windows: { name: "Windows", Icon: WindowsIcon },
  bsd: { name: "BSD", Icon: FreebsdIcon },
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
