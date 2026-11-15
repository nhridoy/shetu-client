import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

export type NewTarget = "host" | "group" | "snippet" | "key";

/** Opens a page's create form for `?new=<target>` (the command palette's "New …"), once. */
export function useNewParam(
  handlers: Partial<Record<NewTarget, () => void>>,
): void {
  const [params, setParams] = useSearchParams();
  const latest = useRef(handlers);
  latest.current = handlers;
  const target = params.get("new");
  useEffect(() => {
    const open = target ? latest.current[target as NewTarget] : undefined;
    if (!open) return;
    setParams(
      (p) => {
        p.delete("new");
        return p;
      },
      { replace: true },
    );
    open();
  }, [target, setParams]);
}
