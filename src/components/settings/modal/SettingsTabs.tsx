import {
  GearSixIcon,
  KeyboardIcon,
  LightningIcon,
  PaletteIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface SettingsTab {
  id: string;
  label: string;
  icon: ReactNode;
}

const settingsTabs: SettingsTab[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: <PaletteIcon className="w-4 h-4" />,
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: <TerminalWindowIcon className="w-4 h-4" />,
  },
  {
    id: "keyboard",
    label: "Keyboard",
    icon: <KeyboardIcon className="w-4 h-4" />,
  },
  {
    id: "ssh",
    label: "SSH",
    icon: <LightningIcon className="w-4 h-4" />,
  },
  {
    id: "security",
    label: "Security",
    icon: <ShieldCheckIcon className="w-4 h-4" />,
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: <GearSixIcon className="w-4 h-4" />,
  },
];

export default settingsTabs;
