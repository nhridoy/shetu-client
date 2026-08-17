import { type Event } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webviewWindow";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { listLocalFiles } from "@/lib/sftp/localFs";
import { fileBrowserActions } from "@/stores/sftp/fileBrowserStore";
import type { FileItem } from "@/types/sftp/sftpTypes";

interface UseTauriDragDropParams {
  paneId: string;
  currentPath: string;
  hostId: string;
  onDrop?: (paths: string[], destDir: string) => void | Promise<void>;
}

interface DropTarget {
  paneId: string;
  hostId: string;
  path: string;
}

/**
 * Resolves the drop target under the cursor.
 * Priority: directory row > container (without data-file-row).
 */
function resolveDropTarget(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;

  const dirRow = el.closest(
    "[data-drop-target-type='directory']",
  ) as HTMLElement | null;
  if (dirRow) {
    const path = dirRow.dataset.dropTargetPath;
    const paneId = dirRow.dataset.dropTargetPane;
    const hostId = dirRow.dataset.dropTargetHost;
    if (path && paneId && hostId) {
      return { paneId, hostId, path };
    }
  }

  let current: HTMLElement | null = el;
  while (current) {
    if (current.dataset.dropTargetPath && !current.dataset.fileRow) {
      const path = current.dataset.dropTargetPath;
      const paneId = current.dataset.dropTargetPane;
      const hostId = current.dataset.dropTargetHost;
      if (path && paneId && hostId) {
        return { paneId, hostId, path };
      }
    }
    current = current.parentElement;
  }

  return null;
}

/**
 * Hook that listens to Tauri's native OS drag-drop events.
 *
 * All panes listen to the same window-level event, but each pane only
 * reacts when the resolved drop target matches its own paneId.
 */
export function useTauriDragDrop({
  paneId,
  currentPath,
  hostId,
  onDrop,
}: UseTauriDragDropParams) {
  const [isDragOver, setIsDragOver] = useState(false);
  const actions = fileBrowserActions;

  // Store mutable values in refs so the effect never needs to re-run
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const handleDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      const lastPos = lastPosRef.current;
      if (!lastPos) return;

      const target = resolveDropTarget(lastPos.x, lastPos.y);
      if (!target) return;
      if (target.paneId !== paneId || target.hostId !== hostId) return;

      const destDir = target.path;

      if (onDropRef.current) {
        await onDropRef.current(paths, destDir);
        return;
      }

      // Detect if paths are files or directories
      const { invoke } = await import("@tauri-apps/api/core");
      const fileItems: FileItem[] = [];

      for (const p of paths) {
        const name = p.split(/[/\\]/).pop() || p;
        // Check if path is a directory
        const isDir = await invoke<boolean>("is_directory", { path: p }).catch(
          () => false,
        );
        const size = isDir
          ? 0
          : await invoke<number>("get_file_size", { path: p }).catch(() => 0);
        fileItems.push({
          name,
          path: p,
          type: isDir ? "directory" : "file",
          size,
          permissions: "",
          owner: "",
          group: "",
          modifiedAt: new Date().toISOString(),
          isHidden: name.startsWith("."),
        });
      }

      // Use unified transferFiles for directory support
      const { transferFiles, LocalFileProvider } = await import(
        "@/lib/sftp/fileTransfer"
      );
      const localProvider = new LocalFileProvider("local");

      await transferFiles({
        source: localProvider,
        dest: localProvider,
        files: fileItems,
        destPath: destDir,
        mode: "copy",
        sessionId: paneId,
      });

      setTimeout(() => {
        actions.loadFiles(paneId, currentPathRef.current, listLocalFiles);
      }, 200);
    },
    [paneId, hostId],
  );

  const handleDropRef = useRef(handleDrop);
  handleDropRef.current = handleDrop;

  // Single listener — only re-runs if paneId or hostId changes (very rare)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const onMouseMove = (e: MouseEvent) => {
      lastPosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMouseMove);

    const appWindow = getCurrentWebviewWindow();

    appWindow
      .onDragDropEvent((event: Event<DragDropEvent>) => {
        if (cancelled) return;
        const payload = event.payload;

        if (payload.type === "enter" || payload.type === "over") {
          const pos = (payload as { position?: { x: number; y: number } })
            .position;
          if (pos) {
            lastPosRef.current = pos;
          }

          const lastPos = lastPosRef.current;
          if (lastPos) {
            const target = resolveDropTarget(lastPos.x, lastPos.y);
            setIsDragOver(
              target?.paneId === paneId && target?.hostId === hostId,
            );
          } else {
            setIsDragOver(false);
          }
        } else if (payload.type === "drop") {
          setIsDragOver(false);
          const droppedPaths: string[] = payload.paths ?? [];
          if (droppedPaths.length > 0) {
            handleDropRef.current(droppedPaths);
          }
        } else {
          setIsDragOver(false);
          lastPosRef.current = null;
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, [paneId, hostId]);

  return { isDragOver };
}
