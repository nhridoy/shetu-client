import { create } from "zustand";

/** A server certificate the user must decide on (from a `cert:` connect error). */
export interface CertPrompt {
  kind: "untrusted" | "changed";
  host: string;
  sha256: string;
  previous: string | null;
}

/** The certificate question in a connect or test error, or null for any other error. */
export function parseCertError(err: unknown): CertPrompt | null {
  const text = err instanceof Error ? err.message : String(err);
  if (!text.startsWith("cert:")) return null;
  try {
    const p = JSON.parse(text.slice("cert:".length)) as CertPrompt;
    return p.sha256 && p.host ? p : null;
  } catch {
    return null;
  }
}

interface CertTrustState {
  queue: { prompt: CertPrompt; resolve: (trusted: boolean) => void }[];
  /** Answers the question on screen. */
  answer: (trusted: boolean) => void;
}

export const useCertTrustStore = create<CertTrustState>((set, get) => ({
  queue: [],
  answer: (trusted) => {
    const [head, ...rest] = get().queue;
    set({ queue: rest });
    head?.resolve(trusted);
  },
}));

/** Asks the user whether to trust a server's certificate; `CertTrustDialog` shows it. */
export function requestCertTrust(prompt: CertPrompt): Promise<boolean> {
  return new Promise((resolve) =>
    useCertTrustStore.setState((s) => ({
      queue: [...s.queue, { prompt, resolve }],
    })),
  );
}
