import type { ReactNode } from "react";
import TerminalDemo from "@/components/auth/TerminalDemo";
import logo from "../../../src-tauri/icons/icon.svg";

const Logo = ({ className = "" }: { className?: string }) => (
  <div
    className={`flex items-center gap-2.5 text-lg font-semibold tracking-tight text-white ${className}`}
  >
    <img src={logo} alt="" className="w-9 h-9" />
    Shetu
  </div>
);

interface AuthLayoutProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}

/** Split-screen shell shared by every auth page: brand panel left, form right. */
export default function AuthLayout({
  title,
  subtitle,
  children,
}: AuthLayoutProps) {
  return (
    <div className="min-h-[calc(100vh-var(--toolbar-height))] bg-dark-950 grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="hidden lg:flex relative overflow-hidden flex-col justify-between gap-8 px-11 py-10 bg-dark-900 border-r border-dark-800 bg-[radial-gradient(600px_380px_at_20%_0%,color-mix(in_srgb,var(--color-primary-500)_16%,transparent),transparent_70%),radial-gradient(500px_300px_at_100%_100%,color-mix(in_srgb,var(--color-primary-400)_8%,transparent),transparent_70%)]">
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(148,163,184,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.06)_1px,transparent_1px)] bg-size-[28px_28px] mask-[radial-gradient(ellipse_at_30%_40%,#000_30%,transparent_75%)]" />
        <Logo className="relative" />
        <div className="relative">
          <TerminalDemo />
        </div>
        <div className="relative">
          <h2 className="text-[26px] leading-tight font-semibold tracking-tight text-white">
            Your servers,
            <br />
            <span className="text-primary-400">everywhere you work.</span>
          </h2>
          <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-dark-400">
            Hosts, keys and port forwards, synced end-to-end encrypted to a
            server you control.
          </p>
          <p className="mt-5 font-mono text-xs text-dark-500">
            open source · MIT · self-hostable
          </p>
        </div>
      </aside>

      <main className="flex items-center justify-center p-8 overflow-auto">
        <div className="w-full max-w-sm">
          <Logo className="lg:hidden mb-6" />
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1.5 text-sm text-dark-400">{subtitle}</p>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
