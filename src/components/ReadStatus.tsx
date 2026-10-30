import "./read-status.css";

type ReadStatusProps = {
  loading: boolean;
  error: string | null | undefined;
  loadingMessage: string;
  errorTitle: string;
  onRetry: () => void;
  retryLabel?: string;
  density?: "comfortable" | "compact";
};

export function ReadStatus({
  loading, error, loadingMessage, errorTitle, onRetry,
  retryLabel = "Retry", density = "comfortable",
}: ReadStatusProps) {
  if (loading) {
    return <div className="read-status" data-density={density} role="status">
      <p>{loadingMessage}</p>
    </div>;
  }
  if (!error) return null;
  return <div className="read-status read-status-error" data-density={density} role="alert">
    <p><strong>{errorTitle}</strong></p>
    <p>{error}</p>
    <button className="button" type="button" onClick={onRetry}>{retryLabel}</button>
  </div>;
}
