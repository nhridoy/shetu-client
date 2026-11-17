import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import QRCode from "qrcode";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import { type TwoFactorStatus, twoFactorApi } from "@/lib/api/twoFactor";

type View =
  | { kind: "status" }
  | { kind: "setup"; qr: string; secret: string; emailCodeSent: boolean }
  | { kind: "codes"; codes: string[] }
  | { kind: "verify"; action: "disable" | "regenerate" };

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

function CodeField({
  label,
  value,
  onChange,
  numeric,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  numeric?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs text-dark-400">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={numeric ? "numeric" : "text"}
        autoComplete="one-time-code"
        className="max-w-xs"
      />
    </div>
  );
}

/** Settings → Security → Two-factor: turn on with an authenticator, turn off, new backup codes. */
export default function TwoFactorSettings() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<View>({ kind: "status" });
  const [code, setCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setStatus(await twoFactorApi.status());
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const show = (next: View) => {
    setView(next);
    setCode("");
    setEmailCode("");
    setSaved(false);
    setError(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const startSetup = () =>
    run(async () => {
      const setup = await twoFactorApi.startSetup();
      show({
        kind: "setup",
        qr: await QRCode.toDataURL(setup.otpauth_url),
        secret: setup.secret,
        emailCodeSent: setup.email_code_sent,
      });
    });

  const confirmSetup = (emailCodeSent: boolean) =>
    run(async () => {
      const { backup_codes } = await twoFactorApi.confirm(
        code,
        emailCodeSent ? emailCode : undefined,
      );
      show({ kind: "codes", codes: backup_codes });
    });

  const confirmVerify = (action: "disable" | "regenerate") =>
    run(async () => {
      if (action === "disable") {
        await twoFactorApi.disable(code);
        toast.success("Two-factor is off");
        show({ kind: "status" });
        await load();
      } else {
        const { backup_codes } = await twoFactorApi.regenerateBackupCodes(code);
        show({ kind: "codes", codes: backup_codes });
      }
    });

  const saveCodes = async (codes: string[]) => {
    try {
      const path = await save({
        defaultPath: "shetu-backup-codes.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, `Shetu backup codes\n\n${codes.join("\n")}\n`);
      toast.success("Backup codes saved");
    } catch (err) {
      toast.error(`Couldn't save the codes: ${message(err)}`);
    }
  };

  const copy = (value: string, what: string) =>
    void writeText(value).then(
      () => toast.success(`${what} copied`),
      () => toast.error(`Couldn't copy the ${what.toLowerCase()}`),
    );

  if (loadError) {
    return (
      <div className="flex items-center gap-3 text-sm text-dark-400">
        Couldn't load two-factor status.
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!status) return <p className="text-sm text-dark-400">Loading…</p>;
  if (!status.available) {
    return (
      <p className="text-sm text-dark-400">
        Two-factor isn't available on this server.
      </p>
    );
  }

  const errorAlert = error && <Alert variant="error">{error}</Alert>;

  if (view.kind === "setup") {
    return (
      <div className="space-y-3 text-sm text-dark-300">
        <p>
          Scan this with your authenticator app, then enter the code it shows.
        </p>
        <img
          src={view.qr}
          alt="Two-factor QR code"
          className="w-40 h-40 rounded bg-white p-2"
        />
        <div className="flex items-center gap-2">
          <code className="text-xs text-white break-all">{view.secret}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copy(view.secret, "Secret")}
          >
            Copy secret
          </Button>
        </div>
        {errorAlert}
        <CodeField
          label="6-digit code"
          value={code}
          onChange={setCode}
          numeric
        />
        {view.emailCodeSent && (
          <CodeField
            label="Code from your email"
            value={emailCode}
            onChange={setEmailCode}
            numeric
          />
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={
              busy || !code.trim() || (view.emailCodeSent && !emailCode.trim())
            }
            onClick={() => void confirmSetup(view.emailCodeSent)}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => show({ kind: "status" })}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (view.kind === "codes") {
    return (
      <div className="space-y-3 text-sm text-dark-300">
        <p>
          Each backup code works once. Keep them somewhere safe: they get you in
          if you lose your phone.
        </p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-white max-w-xs">
          {view.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => copy(view.codes.join("\n"), "Backup codes")}
          >
            Copy codes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void saveCodes(view.codes)}
          >
            Save to file
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="two-factor-saved"
            checked={saved}
            onCheckedChange={setSaved}
            aria-label="I saved these backup codes"
          />
          <label htmlFor="two-factor-saved">I saved these backup codes</label>
        </div>
        <Button
          size="sm"
          disabled={!saved}
          onClick={() => {
            show({ kind: "status" });
            void load();
          }}
        >
          Done
        </Button>
      </div>
    );
  }

  if (view.kind === "verify") {
    return (
      <div className="space-y-3 text-sm text-dark-300">
        <p>
          {view.action === "disable"
            ? "Turning two-factor off means only your password protects new sign-ins."
            : "New backup codes replace the old ones, which stop working."}
        </p>
        {errorAlert}
        <CodeField
          label="Code from your authenticator or a backup code"
          value={code}
          onChange={setCode}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={view.action === "disable" ? "destructive" : "default"}
            disabled={busy || !code.trim()}
            onClick={() => void confirmVerify(view.action)}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => show({ kind: "status" })}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm text-dark-300">
      {errorAlert}
      {status.enabled ? (
        <>
          <p>
            <span className="text-white">On.</span> New sign-ins ask for a code
            from your authenticator app. {status.backup_codes_left} backup codes
            left
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => show({ kind: "verify", action: "regenerate" })}
            >
              New backup codes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => show({ kind: "verify", action: "disable" })}
            >
              Turn off
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            <span className="text-white">Off.</span> Ask for a code from an
            authenticator app when signing in.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void startSetup()}>
            Turn on
          </Button>
        </>
      )}
    </div>
  );
}
