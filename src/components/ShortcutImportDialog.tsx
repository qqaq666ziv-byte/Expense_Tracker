import { lazy, Suspense, useEffect, useRef, type ComponentProps } from "react";
import { X } from "lucide-react";

const ShortcutsPanel = lazy(() => import("../features/shortcuts/ShortcutsPanel").then(
  (module) => ({ default: module.ShortcutsPanel }),
));

type ShortcutImportDialogProps = ComponentProps<typeof ShortcutsPanel> & {
  onClose(): void;
};

/** Mounted within FinanceOwnerBoundary so drafts and credentials never cross owners. */
export function ShortcutImportDialog({ onClose, ...props }: ShortcutImportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="settings-overlay shortcut-dialog"
      aria-labelledby="shortcut-dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header>
        <button type="button" onClick={onClose} autoFocus aria-label="關閉捷徑記帳">
          <X />關閉
        </button>
        <div>
          <p className="section-kicker">讓消費留下紀錄</p>
          <h1 id="shortcut-dialog-title">iPhone 捷徑記帳</h1>
        </div>
      </header>
      <div className="settings-content">
        <Suspense fallback={<p role="status">正在載入捷徑設定…</p>}>
          <ShortcutsPanel {...props} />
        </Suspense>
      </div>
    </dialog>
  );
}
