import type { BatchDecision, ChatMessage as Msg } from "../lib/types";
import TraversalResult from "./TraversalResult";

interface Props {
  message: Msg;
  expandedBatchIds: ReadonlySet<string>;
  selectedBatchId?: string | null;
  onToggleBatch: (batchId: string) => void;
  onBatchSelect?: (batch: BatchDecision) => void;
  onCodeSelect?: (code: string) => void;
}

export default function ChatMessage({
  message,
  expandedBatchIds,
  selectedBatchId,
  onToggleBatch,
  onBatchSelect,
  onCodeSelect,
}: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`rounded-xl px-4 py-3 ${
          isUser
            ? "max-w-3xl bg-blue-600 text-white"
            : "w-full bg-white border border-slate-200"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : message.run ? (
          <TraversalResult
            run={message.run}
            expandedBatchIds={expandedBatchIds}
            selectedBatchId={selectedBatchId}
            onToggleBatch={onToggleBatch}
            onBatchSelect={onBatchSelect}
            onCodeSelect={onCodeSelect}
          />
        ) : (
          <p className="whitespace-pre-wrap text-sm text-slate-700">
            {message.content}
          </p>
        )}
      </div>
    </div>
  );
}
