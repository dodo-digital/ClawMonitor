import { AlertTriangle, RefreshCw } from "lucide-react";

type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-ink-muted">
      <AlertTriangle className="w-10 h-10 mb-3 text-warning" />
      <p className="text-sm mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-card text-ink hover:bg-cream-dark transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      )}
    </div>
  );
}
