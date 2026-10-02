import type { Theme } from "@/stores/themeStore";

export type { Theme };

export interface AppearanceTabProps {
  currentTheme: string;
  fontSize: number;
  fontFamily: string;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
}

export interface TerminalTabProps {
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
  bellStyle: string;
  recordTerminalOutput: boolean;
  setCursorStyle: (style: string) => void;
  setCursorBlink: (blink: boolean) => void;
  setScrollback: (lines: number) => void;
  setBellStyle: (style: string) => void;
  setRecordTerminalOutput: (enabled: boolean) => void;
}

export interface SshTabProps {
  knownHosts: Array<{ host: string; port: number; fingerprint: string }>;
  knownHostsLoading: boolean;
  onLoadKnownHosts: () => void;
  onRemoveKnownHost: (host: string, port: number) => void;
  onClearAllKnownHosts: () => void;
}

export interface SecurityTabProps {
  tabs: Array<{ id: string }>;
  onClearAllSessions: () => void;
}

export interface AdvancedTabProps {
  currentTheme: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
  bellStyle: string;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setCursorStyle: (style: string) => void;
  setCursorBlink: (blink: boolean) => void;
  setScrollback: (lines: number) => void;
  setBellStyle: (style: string) => void;
}
