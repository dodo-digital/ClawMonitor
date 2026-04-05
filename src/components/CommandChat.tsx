import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { MessageSquare, Send, X, Loader2 } from "lucide-react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const PAGE_CONTEXT: Record<string, string> = {
  "/": "the Dashboard (system overview, metrics, recent runs)",
  "/security": "the Security page (config health, access surface, channel activity)",
  "/incidents": "the Incidents page (open/resolved incidents)",
  "/cron": "the Cron Jobs page",
  "/memory": "the Knowledge Graph page",
  "/identity": "the Identity page (bootstrap files)",
  "/agents": "the Agents page",
  "/skills": "the Skills page",
  "/activity": "the Activity page (sessions and live feed)",
};

export function CommandChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const location = useLocation();

  // Cmd+K to open/close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Focus input when opening
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);

    // Build context-aware system message
    const pageCtx = PAGE_CONTEXT[location.pathname] ?? `page: ${location.pathname}`;
    const systemMsg = {
      role: "system" as const,
      content: `You are an OpenClaw assistant embedded in the ClawMonitor dashboard. The user is currently viewing ${pageCtx}. Help them understand what they're seeing and take actions on their OpenClaw instance. Be concise.`,
    };

    const apiMessages = [
      systemMsg,
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];

    const assistantMsg: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${errorText.slice(0, 200)}` };
          return updated;
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, content: last.content + delta };
                return updated;
              });
            }
          } catch {
            // skip parse errors
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${(err as Error).message}` };
          return updated;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, messages, location.pathname]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div className="relative w-full max-w-xl bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
          <MessageSquare className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs font-medium text-ink">Ask OpenClaw</span>
          <span className="text-[10px] text-ink-faint ml-1">via acp-claude</span>
          <button onClick={() => setOpen(false)} className="ml-auto text-ink-faint hover:text-ink transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[100px]">
          {messages.length === 0 && (
            <p className="text-xs text-ink-faint text-center py-4">
              Ask anything about your OpenClaw instance. The agent has context about this page and can take actions.
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={cn("text-sm", msg.role === "user" ? "text-right" : "")}>
              {msg.role === "user" ? (
                <span className="inline-block bg-accent/10 text-ink px-3 py-1.5 rounded-lg text-xs">
                  {msg.content}
                </span>
              ) : (
                <div className="text-xs text-ink-muted leading-relaxed whitespace-pre-wrap">
                  {msg.content || (streaming && i === messages.length - 1 && (
                    <Loader2 className="w-3 h-3 animate-spin text-ink-faint inline" />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="border-t border-border/60 px-3 py-2 flex items-center gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask something..."
            disabled={streaming}
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint outline-none disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="text-ink-faint hover:text-accent transition-colors disabled:opacity-30"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
          <span className="text-[10px] text-ink-faint/50 ml-1">
            {streaming ? "streaming..." : "⌘K"}
          </span>
        </div>
      </div>
    </div>
  );
}
