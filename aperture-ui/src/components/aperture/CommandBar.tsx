import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";

interface Props {
  onSubmit: (line: string) => void;
  history: string[];
  disabled?: boolean;
}

/// `SYMBOL VERB ARGS GO` command line with up/down history. The form prevents
/// the default submit so the page doesn't reload; the parent owns the value.
export function CommandBar({ onSubmit, history, disabled }: Props) {
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const line = input.trim();
    if (!line) return;
    onSubmit(line);
    setInput("");
    setCursor(null);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" && history.length > 0) {
      e.preventDefault();
      const next = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(next);
      setInput(history[next] ?? "");
    } else if (e.key === "ArrowDown" && cursor !== null) {
      e.preventDefault();
      const next = cursor + 1;
      if (next >= history.length) {
        setCursor(null);
        setInput("");
      } else {
        setCursor(next);
        setInput(history[next] ?? "");
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-zinc-800 bg-zinc-950 p-2">
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        placeholder="SYMBOL VERB [ARGS] GO   (e.g. AAPL CHART 6M GO)"
        autoComplete="off"
        autoFocus
        disabled={disabled}
        className="bg-zinc-900 border-zinc-800 text-zinc-100 font-mono text-xs"
      />
    </form>
  );
}
