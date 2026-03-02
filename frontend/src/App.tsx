import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatMessage from "./components/ChatMessage";
import CodeTraversal from "./components/CodeTraversal";
import ConfigureModal from "./components/ConfigureModal";
import InputBar from "./components/InputBar";
import PromptLog from "./components/PromptLog";
import { useConfig } from "./hooks/useConfig";
import { useTraversal } from "./hooks/useTraversal";
import { sortBatchesDFS } from "./lib/parse";
import type { BatchDecision, ChatMessage as Msg, GepaLogEntry, GepaResult } from "./lib/types";

export default function App() {
  const { settings, setSettings } = useConfig();
  const { run, start, updateRun, updateGepa } = useTraversal();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [configOpen, setConfigOpen] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<BatchDecision | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<string>>(
    new Set(),
  );
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Track the assistant message id linked to the current run
  const runMsgIdRef = useRef<string | null>(null);

  const toggleBatch = useCallback((batchId: string) => {
    setExpandedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) {
        next.delete(batchId);
      } else {
        next.add(batchId);
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    (note: string) => {
      const userMsg: Msg = {
        id: crypto.randomUUID(),
        role: "user",
        content: note,
      };
      const assistantMsg: Msg = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      runMsgIdRef.current = assistantMsg.id;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setSelectedCode(null);
      setSelectedBatch(null);
      setExpandedBatchIds(new Set());
      start(note, settings);
    },
    [settings, start],
  );

  // Sync run state into the assistant message
  useEffect(() => {
    if (!run || !runMsgIdRef.current) return;
    const msgId = runMsgIdRef.current;
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, run } : m)),
    );
  }, [run]);

  // Auto-scroll on new messages or run updates
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, run]);

  const handleOptimizeComplete = useCallback(
    (newBatches: BatchDecision[], newFinalCodes: string[]) => {
      updateRun(newBatches, newFinalCodes);
      // If the currently selected code is no longer in final codes,
      // try to switch to the gold code if it is, otherwise deselect
      setSelectedCode((prev) => {
        if (prev && newFinalCodes.includes(prev)) return prev;
        return null;
      });
    },
    [updateRun],
  );

  const handleGepaLog = useCallback(
    (log: GepaLogEntry[], result: GepaResult | null) => {
      updateGepa(log, result);
    },
    [updateGepa],
  );

  const isTraversing = run?.status === "traversing";

  // DFS-sorted batches for the prompt log (same order as the trace tree)
  const logBatches = useMemo(
    () => (run ? sortBatchesDFS(run.batches) : []),
    [run?.batches],
  );

  return (
    <div className="flex h-full flex-col bg-slate-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-slate-800">
            MEDSTRAL
            <span className="ml-2 text-sm font-normal text-slate-400">
              ICD-10-CM Agentic Coding
            </span>
          </h1>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono text-slate-500">
            {settings.model}
          </span>
        </div>
      </header>

      {/* Main content: left panel + chat (right) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — PromptLog or CodeTraversal */}
        <div className="w-80 shrink-0">
          {selectedCode ? (
            <CodeTraversal
              code={selectedCode}
              batches={logBatches}
              clinicalNote={run?.clinicalNote ?? ""}
              settings={settings}
              onToggleBatch={toggleBatch}
              onBack={() => setSelectedCode(null)}
              onOptimizeComplete={handleOptimizeComplete}
              onGepaLog={handleGepaLog}
            />
          ) : (
            <PromptLog
              batches={logBatches}
              status={run?.status ?? "idle"}
              selectedBatchId={selectedBatch?.batchId ?? null}
              gepaLog={run?.gepaLog ?? []}
              gepaResult={run?.gepaResult ?? null}
            />
          )}
        </div>

        {/* Chat column */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Chat area */}
          <main className="flex-1 overflow-y-auto px-2 py-6">
            <div className="space-y-4">
              {messages.length === 0 && (
                <div className="py-20 text-center text-sm text-slate-400">
                  Paste a clinical note below to begin ICD-10-CM coding.
                </div>
              )}
              {messages.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  expandedBatchIds={expandedBatchIds}
                  selectedBatchId={selectedBatch?.batchId ?? null}
                  onToggleBatch={toggleBatch}
                  onBatchSelect={setSelectedBatch}
                  onCodeSelect={setSelectedCode}
                />
              ))}
              <div ref={chatEndRef} />
            </div>
          </main>

          {/* Input bar */}
          <InputBar
            onSubmit={handleSubmit}
            onConfigure={() => setConfigOpen(true)}
            disabled={isTraversing}
          />
        </div>
      </div>

      {/* Config modal */}
      <ConfigureModal
        open={configOpen}
        settings={settings}
        onSave={setSettings}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}
