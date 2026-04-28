import "@xterm/xterm/css/xterm.css";
import { type ITerminalInitOnlyOptions, type ITerminalOptions, Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

export function useXTerm(options?: ITerminalOptions & ITerminalInitOnlyOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  const [instance, setInstance] = useState<Terminal | null>(null);

  useEffect(() => {
    const terminal = new Terminal(optionsRef.current);
    if (ref.current) {
      terminal.open(ref.current);
      terminal.focus();
    }
    setInstance(terminal);
    return () => {
      terminal.dispose();
      setInstance(null);
    };
  }, []);

  return { ref, instance };
}
