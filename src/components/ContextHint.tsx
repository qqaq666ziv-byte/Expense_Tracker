import { useEffect, useState, type ReactNode } from "react";
import { Lightbulb, X } from "lucide-react";

const keyFor = (id: string) => `shiba-finance:context-hint:v1:${id}`;

export function ContextHint({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(!localStorage.getItem(keyFor(id)));
    } catch {
      setVisible(true);
    }
  }, [id]);

  if (!visible) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(keyFor(id), "dismissed");
    } catch {
      /* Context hints are optional UI preferences. */
    }
    setVisible(false);
  };

  return (
    <aside className="context-hint" aria-label={`${title}提示`}>
      <Lightbulb />
      <span>
        <strong>{title}</strong>
        <small>{children}</small>
      </span>
      <button
        type="button"
        aria-label={`知道了，關閉${title}提示`}
        onClick={dismiss}
      >
        <X />
      </button>
    </aside>
  );
}
