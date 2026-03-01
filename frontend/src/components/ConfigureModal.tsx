import { useCallback, useEffect, useState } from "react";
import type { LLMSettings } from "../lib/types";

interface Props {
  open: boolean;
  settings: LLMSettings;
  onSave: (settings: LLMSettings) => void;
  onClose: () => void;
}

export default function ConfigureModal({
  open,
  settings,
  onSave,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const handleSave = useCallback(() => {
    onSave(draft);
    onClose();
  }, [draft, onSave, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-slate-800">
          LLM Configuration
        </h2>

        <div className="space-y-4">
          {/* Model */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Model
            </label>
            <input
              type="text"
              value={draft.model}
              onChange={(e) =>
                setDraft((d) => ({ ...d, model: e.target.value }))
              }
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          {/* Temperature */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Temperature{" "}
              <span className="text-slate-400">({draft.temperature})</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.temperature}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v))
                  setDraft((d) => ({ ...d, temperature: v }));
              }}
              className="w-full"
            />
          </div>

          {/* Max Tokens */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Max Tokens
            </label>
            <input
              type="number"
              min={256}
              max={32768}
              step={256}
              value={draft.maxTokens}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v) && v >= 256)
                  setDraft((d) => ({ ...d, maxTokens: v }));
              }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          {/* Scaffolded toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">
              Scaffolded traversal
            </span>
            <button
              onClick={() =>
                setDraft((d) => ({ ...d, scaffolded: !d.scaffolded }))
              }
              className={`relative h-6 w-11 rounded-full transition-colors ${
                draft.scaffolded ? "bg-blue-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  draft.scaffolded ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          {/* Cache toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">
              Enable caching
            </span>
            <button
              onClick={() =>
                setDraft((d) => ({ ...d, persistCache: !d.persistCache }))
              }
              className={`relative h-6 w-11 rounded-full transition-colors ${
                draft.persistCache ? "bg-blue-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  draft.persistCache ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600
                       hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
