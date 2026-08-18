import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
      <div className="text-dark-600 mb-3">{icon}</div>
      <p className="text-sm text-dark-300">{title}</p>
      {description && (
        <p className="text-xs text-dark-500 mt-1">{description}</p>
      )}
      {action && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  );
}
