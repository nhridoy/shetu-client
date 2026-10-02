import {
  ClockCounterClockwiseIcon,
  TerminalIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import Select from "@/components/ui/Select";
import Spinner from "@/components/ui/Spinner";
import { formatDurationMs } from "@/lib/common/formatting";
import { useSessionStore } from "@/stores/sessions/sessionStore";

export default function HistoryView() {
  const {
    sessions,
    selectedSession,
    output,
    isLoading,
    error,
    fetchSessions,
    selectSession,
    fetchLogs,
    deleteSession,
    retentionDays,
    setRetentionDays,
  } = useSessionStore();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "today" | "week" | "month">(
    "all",
  );

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);
  useEffect(() => {
    if (selectedSession?.recording) void fetchLogs(selectedSession.id);
  }, [selectedSession, fetchLogs]);

  const filtered = useMemo(
    () =>
      sessions.filter((item) => {
        if (!item.host_label.toLowerCase().includes(search.toLowerCase()))
          return false;
        if (filter === "all") return true;
        const days =
          (Date.now() - new Date(item.started_at).getTime()) / 86_400_000;
        return days < { today: 1, week: 7, month: 30 }[filter];
      }),
    [sessions, search, filter],
  );

  const duration = (start: string, end: string | null) =>
    formatDurationMs(
      Math.max(0, new Date(end ?? start).getTime() - new Date(start).getTime()),
    );

  return (
    <div className="flex-1 p-4 overflow-y-auto space-y-4">
      <SectionHeader
        title="Session History"
        level="h3"
        className="text-sm tracking-wider uppercase text-dark-400"
      >
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Search hosts"
            placeholder="Search hosts..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as typeof filter)}
            options={[
              { value: "all", label: "All time" },
              { value: "today", label: "Today" },
              { value: "week", label: "This week" },
              { value: "month", label: "This month" },
            ]}
          />
        </div>
      </SectionHeader>
      <div className="flex items-center gap-3 text-sm text-dark-300">
        <span>Keep history and recordings for</span>
        <Select
          value={String(retentionDays)}
          onValueChange={(value) =>
            void setRetentionDays(Number(value) as 7 | 30 | 90)
          }
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </div>
      {error && (
        <p role="alert" className="text-red-400 text-sm">
          {error}
        </p>
      )}
      {isLoading && <Spinner />}
      {!isLoading && filtered.length === 0 && (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No sessions found"
          description="Connect to a host or local shell to start your history."
        />
      )}
      <div className="space-y-1">
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => selectSession(item)}
            className={`w-full text-left flex items-center gap-3 rounded-lg p-3 ${selectedSession?.id === item.id ? "bg-dark-700" : "hover:bg-dark-800"}`}
          >
            <TerminalIcon className="w-5 h-5 text-primary-500 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-white truncate">
                {item.host_label || "Local terminal"}
              </span>
              <span className="block text-xs text-dark-400">
                {new Date(item.started_at).toLocaleString()} ·{" "}
                {item.connection_type.toUpperCase()} · {item.state} ·{" "}
                {duration(item.started_at, item.ended_at)}
              </span>
            </span>
            {item.recording && (
              <span className="text-xs text-amber-300">
                {item.truncated ? "Truncated" : "Recorded"}
              </span>
            )}
          </button>
        ))}
      </div>
      {selectedSession && (
        <section
          className="rounded-lg border border-dark-700 bg-dark-800/50 p-4 space-y-3"
          aria-label="Session details"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-white font-medium">
              {selectedSession.host_label || "Local terminal"}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                void deleteSession(selectedSession.id).catch(() => {})
              }
            >
              <TrashIcon className="w-4 h-4" /> Delete
            </Button>
          </div>
          <p className="text-sm text-dark-300">
            {selectedSession.state} · Started{" "}
            {new Date(selectedSession.started_at).toLocaleString()}
            {selectedSession.ended_at
              ? ` · Ended ${new Date(selectedSession.ended_at).toLocaleString()}`
              : ""}
          </p>
          {selectedSession.reason && (
            <p className="text-sm text-dark-400">{selectedSession.reason}</p>
          )}
          {selectedSession.recording ? (
            <div>
              <p className="text-xs text-amber-300 mb-2">
                Terminal output can contain secrets. This recording is encrypted
                and synced to your devices.
              </p>
              {selectedSession.truncated && (
                <p className="text-xs text-amber-300 mb-2">
                  Recording stopped at the 10 MiB limit.
                </p>
              )}
              <pre className="bg-dark-900 rounded p-3 text-sm text-dark-200 whitespace-pre-wrap break-words max-h-96 overflow-auto">
                {output || "No output recorded."}
              </pre>
            </div>
          ) : (
            <p className="text-sm text-dark-400">
              Output was not recorded for this session.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
