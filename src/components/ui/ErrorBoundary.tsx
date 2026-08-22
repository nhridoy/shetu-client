import { WarningCircleIcon } from "@phosphor-icons/react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  onReset: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full bg-dark-950 p-4">
          <WarningCircleIcon
            className="w-8 h-8 text-red-400 mb-2"
            weight="bold"
          />
          <p className="text-sm text-dark-200 text-center mb-3">
            Something went wrong
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, error: null });
              this.props.onReset();
            }}
            className="px-3 py-1.5 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-500 transition-colors"
          >
            Restart pane
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
