import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { extractError } from "@/lib/common/extractError";
import { parseCertError, requestCertTrust } from "@/lib/storage/certTrust";
import {
  type StorageAccount,
  type StorageAccountPatch,
  type StorageProvider,
  useStorageAccountStore,
} from "@/stores/storage/storageAccountStore";

const PROVIDERS: { value: StorageProvider; label: string }[] = [
  { value: "aws", label: "Amazon S3" },
  { value: "r2", label: "Cloudflare R2" },
  { value: "b2", label: "Backblaze B2" },
  { value: "wasabi", label: "Wasabi" },
  { value: "spaces", label: "DigitalOcean Spaces" },
  { value: "custom", label: "Custom (MinIO, other S3-compatible)" },
  { value: "webdav", label: "WebDAV (Nextcloud, ownCloud, NAS)" },
];

interface Form {
  name: string;
  provider: StorageProvider;
  region: string;
  bucket: string;
  r2AccountId: string;
  endpoint: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  webdavKind: "nextcloud" | "other";
  server: string;
  url: string;
  username: string;
  password: string;
  trustedCertSha256: string | null;
  /** The user trusted or forgot a certificate in this form: send it on Save. */
  pinTouched: boolean;
}

const EMPTY: Form = {
  name: "",
  provider: "aws",
  region: "",
  bucket: "",
  r2AccountId: "",
  endpoint: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
  webdavKind: "nextcloud",
  server: "",
  url: "",
  username: "",
  password: "",
  trustedCertSha256: null,
  pinTouched: false,
};

/** The WebDAV address (the same rule as Rust's `webdav_url`), for display. */
export function davUrl(f: Form): string {
  if (f.webdavKind === "other") return f.url;
  const host = f.server
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return `https://${host || "<server>"}/remote.php/webdav/`;
}

/** The endpoint a preset uses (the same rule as Rust's `endpoint_for`), for display. */
export function presetEndpoint(f: Form): string {
  const r = f.region.trim() || "<region>";
  switch (f.provider) {
    case "aws":
      return `https://s3.${r}.amazonaws.com`;
    case "r2":
      return `https://${f.r2AccountId.trim() || "<account-id>"}.r2.cloudflarestorage.com`;
    case "b2":
      return `https://s3.${r}.backblazeb2.com`;
    case "wasabi":
      return `https://s3.${r}.wasabisys.com`;
    case "spaces":
      return `https://${r}.digitaloceanspaces.com`;
    default:
      return f.endpoint;
  }
}

/** Only what the form holds; an untyped secret is left out so Rust keeps the stored one. */
function toPatch(f: Form): StorageAccountPatch {
  if (f.provider === "webdav") {
    const dav: StorageAccountPatch = {
      provider: "webdav",
      webdavKind: f.webdavKind,
      username: f.username.trim(),
    };
    if (f.webdavKind === "nextcloud") dav.server = f.server.trim();
    else dav.url = f.url.trim();
    if (f.password) dav.password = f.password;
    if (f.pinTouched) dav.trustedCertSha256 = f.trustedCertSha256;
    return dav;
  }
  const patch: StorageAccountPatch = {
    provider: f.provider,
    region: f.region.trim(),
    bucket: f.bucket.trim(),
    accessKeyId: f.accessKeyId.trim(),
  };
  if (f.provider === "r2") patch.r2AccountId = f.r2AccountId.trim();
  if (f.provider === "custom") {
    patch.endpoint = f.endpoint.trim();
    patch.pathStyle = f.pathStyle;
  }
  if (f.secretAccessKey) patch.secretAccessKey = f.secretAccessKey;
  return patch;
}

const selectClass =
  "w-full h-7 bg-dark-900 text-white px-2 text-sm rounded-md border border-dark-700 focus:outline-none focus:ring-2 focus:ring-primary-500";

export default function StorageAccountModal({
  account,
  onClose,
}: {
  account: StorageAccount | "new";
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>({
    ...EMPTY,
    name: account === "new" ? "" : account.name,
  });
  const [hasSecret, setHasSecret] = useState(false);
  // An edit starts locked until the saved values arrive, so they can't overwrite typing.
  const [loaded, setLoaded] = useState(account === "new");
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = account === "new" ? null : account.id;
  const uid = useId();

  useEffect(() => {
    if (!id) return;
    let live = true;
    void useStorageAccountStore
      .getState()
      .view(id)
      .then((v) => {
        if (!live) return;
        if (!v) {
          setError("Couldn't load this account");
          return;
        }
        setLoaded(true);
        setHasSecret(v.hasSecret);
        setForm((f) => ({
          ...f,
          provider: v.provider,
          region: v.region,
          bucket: v.bucket,
          r2AccountId: v.r2AccountId ?? "",
          endpoint: v.endpoint ?? "",
          pathStyle: v.pathStyle,
          accessKeyId: v.accessKeyId,
          webdavKind: v.webdavKind === "other" ? "other" : "nextcloud",
          server: v.server ?? "",
          url: v.url ?? "",
          username: v.username ?? "",
          trustedCertSha256: v.trustedCertSha256 ?? null,
        }));
      })
      .catch(() => {
        if (live) setError("Couldn't load this account");
      });
    return () => {
      live = false;
    };
  }, [id]);

  const set =
    <K extends keyof Form>(key: K) =>
    (value: Form[K]) =>
      setForm((f) => ({ ...f, [key]: value }));
  const text = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(key)(e.target.value as never);

  const runTest = async () => {
    setTestResult(null);
    setError(null);
    setBusy(true);
    const store = useStorageAccountStore.getState();
    try {
      setTestResult(await store.test(id, toPatch(form)));
    } catch (err) {
      const prompt = parseCertError(err);
      // Trusting here only goes into the form; Save stores it (never a half-filled account).
      if (prompt && (await requestCertTrust(prompt))) {
        const next = {
          ...form,
          trustedCertSha256: prompt.sha256,
          pinTouched: true,
        };
        setForm(next);
        try {
          setTestResult(await store.test(id, toPatch(next)));
        } catch (again) {
          setError(extractError(again, "Couldn't connect"));
        }
      } else if (!prompt) {
        setError(extractError(err, "Couldn't connect"));
      }
    } finally {
      setBusy(false);
    }
  };

  const webdav = form.provider === "webdav";
  const submit = async () => {
    if (!webdav && !form.bucket.trim()) {
      setError("Bucket is required");
      return;
    }
    setError(null);
    setBusy(true);
    const store = useStorageAccountStore.getState();
    const fallbackName = webdav ? davUrl(form) : form.bucket.trim();
    const ok = await store.save(
      id,
      form.name.trim() || fallbackName,
      toPatch(form),
    );
    setBusy(false);
    if (ok) onClose();
    else setError(useStorageAccountStore.getState().error);
  };

  const custom = form.provider === "custom";
  return (
    <Modal
      open
      onClose={onClose}
      title={id ? "Edit storage account" : "New storage account"}
    >
      <form
        className="text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={!loaded} className="space-y-2">
          <Field>
            <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
            <Input
              id={`${uid}-name`}
              name="name"
              value={form.name}
              onChange={text("name")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-provider`}>Provider</FieldLabel>
            <select
              id={`${uid}-provider`}
              name="provider"
              className={selectClass}
              value={form.provider}
              onChange={(e) =>
                set("provider")(e.target.value as StorageProvider)
              }
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {webdav ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${uid}-webdavKind`}>
                  Server type
                </FieldLabel>
                <select
                  id={`${uid}-webdavKind`}
                  name="webdavKind"
                  className={selectClass}
                  value={form.webdavKind}
                  onChange={(e) =>
                    set("webdavKind")(e.target.value as Form["webdavKind"])
                  }
                >
                  <option value="nextcloud">Nextcloud / ownCloud</option>
                  <option value="other">Other WebDAV</option>
                </select>
              </Field>
              {form.webdavKind === "nextcloud" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor={`${uid}-server`}>Server</FieldLabel>
                    <Input
                      id={`${uid}-server`}
                      name="server"
                      value={form.server}
                      placeholder="cloud.example.com"
                      onChange={text("server")}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${uid}-davUrl`}>Address</FieldLabel>
                    <Input
                      id={`${uid}-davUrl`}
                      name="davUrl"
                      value={davUrl(form)}
                      readOnly
                    />
                  </Field>
                </>
              ) : (
                <Field>
                  <FieldLabel htmlFor={`${uid}-url`}>URL</FieldLabel>
                  <Input
                    id={`${uid}-url`}
                    name="url"
                    value={form.url}
                    placeholder="https://nas.local:5006/dav/"
                    onChange={text("url")}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={`${uid}-username`}>Username</FieldLabel>
                <Input
                  id={`${uid}-username`}
                  name="username"
                  value={form.username}
                  autoComplete="off"
                  onChange={text("username")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-password`}>
                  Password{hasSecret && " (Saved — leave empty to keep it)"}
                </FieldLabel>
                <Input
                  id={`${uid}-password`}
                  name="password"
                  type="password"
                  value={form.password}
                  autoComplete="off"
                  onChange={text("password")}
                />
              </Field>
              {form.trustedCertSha256 && (
                <div className="flex items-center gap-2 text-xs text-dark-300">
                  <span className="flex-1 truncate">
                    Trusted certificate {form.trustedCertSha256.slice(0, 16)}…
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        trustedCertSha256: null,
                        pinTouched: true,
                      }))
                    }
                  >
                    Forget
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              {form.provider === "r2" && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-r2AccountId`}>
                    Cloudflare account ID
                  </FieldLabel>
                  <Input
                    id={`${uid}-r2AccountId`}
                    name="r2AccountId"
                    value={form.r2AccountId}
                    onChange={text("r2AccountId")}
                  />
                </Field>
              )}
              {form.provider !== "r2" && (
                <Field>
                  <FieldLabel htmlFor={`${uid}-region`}>Region</FieldLabel>
                  <Input
                    id={`${uid}-region`}
                    name="region"
                    value={form.region}
                    placeholder="us-east-1"
                    onChange={text("region")}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor={`${uid}-endpoint`}>Endpoint</FieldLabel>
                <Input
                  id={`${uid}-endpoint`}
                  name="endpoint"
                  value={custom ? form.endpoint : presetEndpoint(form)}
                  readOnly={!custom}
                  placeholder="https://minio.example.com"
                  onChange={text("endpoint")}
                />
              </Field>
              {custom && (
                <div className="flex items-center gap-2">
                  <Checkbox
                    name="pathStyle"
                    checked={form.pathStyle}
                    onCheckedChange={set("pathStyle")}
                    aria-label="Path-style addressing"
                  />
                  <span className="text-dark-300">
                    Path-style addressing (MinIO usually needs this)
                  </span>
                </div>
              )}
              <Field>
                <FieldLabel htmlFor={`${uid}-bucket`}>Bucket</FieldLabel>
                <Input
                  id={`${uid}-bucket`}
                  name="bucket"
                  value={form.bucket}
                  onChange={text("bucket")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-accessKeyId`}>
                  Access key
                </FieldLabel>
                <Input
                  id={`${uid}-accessKeyId`}
                  name="accessKeyId"
                  value={form.accessKeyId}
                  autoComplete="off"
                  onChange={text("accessKeyId")}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-secretAccessKey`}>
                  Secret key{hasSecret && " (Saved — leave empty to keep it)"}
                </FieldLabel>
                <Input
                  id={`${uid}-secretAccessKey`}
                  name="secretAccessKey"
                  type="password"
                  value={form.secretAccessKey}
                  autoComplete="off"
                  onChange={text("secretAccessKey")}
                />
              </Field>
              <p className="text-xs text-dark-400">
                Interrupted uploads can leave parts in the bucket. Add a
                lifecycle rule to delete incomplete multipart uploads after a
                few days.
              </p>
            </>
          )}
          {testResult && <p className="text-xs text-green-400">{testResult}</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !loaded}
              onClick={() => void runTest()}
            >
              Test connection
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !loaded}>
              Save
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
