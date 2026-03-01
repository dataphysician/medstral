import { parseAGUIEvent } from "./parse";
import type { AGUIEvent } from "./types";

/**
 * Minimal SSE client that speaks AG-UI protocol.
 * No @ag-ui/client or rxjs dependency — just fetch + ReadableStream.
 */

export interface StreamHandle {
  abort: () => void;
}

export function streamSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: AGUIEvent) => void,
  onError: (err: Error) => void,
  onDone: () => void,
): StreamHandle {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines: "data: {...}\n\n"
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (line.startsWith("data: ")) {
              const json = line.slice(6).trim();
              if (!json) continue;
              try {
                const parsed: unknown = JSON.parse(json);
                const event = parseAGUIEvent(parsed);
                if (event) onEvent(event);
              } catch {
                // skip malformed lines
              }
            }
          }
        }
      }

      onDone();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        onDone();
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return { abort: () => controller.abort() };
}
