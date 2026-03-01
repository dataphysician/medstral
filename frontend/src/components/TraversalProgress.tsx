interface Props {
  batchCount: number;
  elapsedMs: number;
}

export default function TraversalProgress({ batchCount, elapsedMs }: Props) {
  const seconds = (elapsedMs / 1000).toFixed(1);

  return (
    <div className="flex items-center gap-3 text-sm text-slate-500">
      {/* Spinner */}
      <svg
        className="h-4 w-4 animate-spin text-blue-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span>
        Traversing... {batchCount} batches &middot; {seconds}s
      </span>
    </div>
  );
}
