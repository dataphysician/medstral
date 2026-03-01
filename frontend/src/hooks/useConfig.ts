import { useCallback, useState } from "react";
import { parseLLMSettings } from "../lib/parse";
import { DEFAULT_SETTINGS, type LLMSettings } from "../lib/types";

const STORAGE_KEY = "medstral:config";

function loadSettings(): LLMSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return parseLLMSettings(parsed);
    }
  } catch {
    // corrupt localStorage — use defaults
  }
  return DEFAULT_SETTINGS;
}

export function useConfig() {
  const [settings, setSettingsRaw] = useState<LLMSettings>(loadSettings);

  const setSettings = useCallback((next: LLMSettings) => {
    setSettingsRaw(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  return { settings, setSettings } as const;
}
