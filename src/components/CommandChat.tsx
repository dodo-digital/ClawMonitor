import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { useSetupStatus } from "@/lib/api";
import { MessageSquare, Send, X, Loader2, RotateCcw } from "lucide-react";

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

const SYSTEM_PROMPT = `You are an OpenClaw operations assistant embedded in the ClawMonitor dashboard. You have full access to the OpenClaw CLI and can run commands on the host.

Rules:
- Be direct and concise. No preamble.
- When the user asks you to do something, do it. Don't ask for confirmation or present numbered menus — just act.
- If you need to run a command, run it. Show what you did and what happened.
- If something could be destructive (like restarting the gateway), warn once briefly then proceed if they confirm.
- Keep responses short. Use markdown for structure when helpful.`;

export function CommandChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const location = useLocation();
  const { data: setupStatus } = useSetupStatus();
  const agentModel = setupStatus?.agentId
    ? `openclaw/${setupStatus.agentId}`
    : "openclaw/acp-clawmonitor";

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

  // Listen for external open-chat events (e.g. from AgentSetupCard)
  useEffect(() => {
    function handleOpenChat(e: Event) {
      const detail = (e as CustomEvent).detail as { prefill?: string } | undefined;
      setOpen(true);
      if (detail?.prefill) {
        setInput(detail.prefill);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    window.addEventListener("openclaw:open-chat", handleOpenChat);
    return () => window.removeEventListener("openclaw:open-chat", handleOpenChat);
  }, []);

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

  function clearChat() {
    setMessages([]);
    setTurnCount(0);
  }

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setTurnCount((c) => c + 1);

    const pageCtx = PAGE_CONTEXT[location.pathname] ?? `page: ${location.pathname}`;
    const systemMsg = {
      role: "system" as const,
      content: `${SYSTEM_PROMPT}\n\nThe user is currently viewing ${pageCtx}.`,
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
        body: JSON.stringify({ messages: apiMessages, model: agentModel, stream: false }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${errorText.slice(0, 200)}` };
          return updated;
        });
        return;
      }

      const raw = await response.text();
      let content = "No response";
      try {
        const data = JSON.parse(raw);
        content = data.choices?.[0]?.message?.content ?? `Unexpected response format: ${raw.slice(0, 100)}`;
      } catch {
        content = raw.slice(0, 500) || "Empty response from server";
      }
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content };
        return updated;
      });
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
  }, [input, streaming, messages, location.pathname, agentModel]);

  return (
    <>
      {/* Cmd+K pill — always visible at bottom right */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-3 bg-card border border-border rounded-full shadow-lg text-sm text-ink-muted hover:text-ink hover:border-accent/40 transition-all"
        >
          <MessageSquare className="w-4 h-4" />
          <span>Ask OpenClaw</span>
          <kbd className="text-xs bg-cream-dark/80 px-2 py-0.5 rounded font-mono text-ink-faint">⌘K</kbd>
        </button>
      )}

      {/* Chat overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />

          <div className="relative w-full max-w-xl bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[70vh]">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
              <MessageSquare className="w-3.5 h-3.5 text-accent" />
              <span className="text-xs font-medium text-ink">Ask OpenClaw</span>
              <span className="text-[10px] text-ink-faint">{setupStatus?.agentId ?? "not connected"}</span>
              {turnCount > 0 && (
                <span className="text-[10px] text-ink-faint bg-cream-dark/60 px-1.5 py-0.5 rounded">
                  {turnCount} turn{turnCount !== 1 ? "s" : ""}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {messages.length > 0 && (
                  <button onClick={clearChat} className="text-ink-faint hover:text-ink transition-colors p-1" title="New conversation">
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="text-ink-faint hover:text-ink transition-colors p-1">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[120px]">
              {messages.length === 0 && !setupStatus?.configured && (
                <div className="text-center py-4">
                  <p className="text-xs text-ink-faint">
                    No agent connected. Set one up from the Dashboard first.
                  </p>
                </div>
              )}
              {messages.length === 0 && setupStatus?.configured && (
                <div className="text-center py-6 space-y-2">
                  <p className="text-xs text-ink-faint">Ask anything about your OpenClaw instance.</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {["What's the system status?", "Harden my Slack config", "Why is this cron job failing?"].map((q) => (
                      <button
                        key={q}
                        onClick={() => { setInput(q); setTimeout(() => inputRef.current?.focus(), 0); }}
                        className="text-[11px] px-2 py-1 rounded-md bg-cream-dark/50 text-ink-muted hover:bg-cream-dark hover:text-ink transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={cn(msg.role === "user" ? "text-right" : "")}>
                  {msg.role === "user" ? (
                    <span className="inline-block bg-accent/10 text-ink px-3 py-1.5 rounded-lg text-xs max-w-[85%] text-left">
                      {msg.content}
                    </span>
                  ) : (
                    <div className="text-xs text-ink-muted leading-relaxed whitespace-pre-wrap">
                      {msg.content || (streaming && i === messages.length - 1 && (
                        <span className="flex items-center gap-2 text-ink-faint py-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Working (may be running commands)...</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Input */}
            <div className="border-t border-border/60 px-3 py-2.5 flex items-center gap-2">
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
                {streaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
