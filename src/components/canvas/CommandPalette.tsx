"use client";

import React, { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  builderCommandStates,
  type BuilderCommandContext,
  type BuilderCommandId,
} from "@/lib/flow/builder-command-registry";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly context: BuilderCommandContext;
  readonly onClose: () => void;
  readonly onCommand: (id: BuilderCommandId, trigger?: HTMLElement) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

export default function CommandPalette({
  open,
  context,
  onClose,
  onCommand,
  triggerRef,
}: CommandPaletteProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const commands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return builderCommandStates(context).filter((command) =>
      normalized === "" || `${command.label} ${command.description}`.toLowerCase().includes(normalized),
    );
  }, [context, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    queueMicrotask(() => inputRef.current?.focus());
    // Reading `.current` at cleanup is the point, not an oversight. `triggerRef`
    // is a prop pointing at a button the PARENT renders, so the rule's "copy it
    // into the effect" advice does not apply — capturing it when the palette
    // opened would send focus back to whichever button was current then, even
    // if the parent has since pointed the ref somewhere else. `close()` below
    // restores focus the same way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => triggerRef.current?.focus();
  }, [open, triggerRef]);

  useEffect(() => {
    // One keyboard model: arrows move aria-activedescendant on the combobox
    // input; the highlighted option must stay scrolled into view. block:
    // "nearest" scrolls instantly, so reduced motion needs no special case.
    if (!open) return;
    const command = commands[Math.min(active, Math.max(0, commands.length - 1))];
    if (!command) return;
    document.getElementById(`builder-command-${command.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, commands]);

  if (!open) return null;
  const activeCommand = commands[Math.min(active, Math.max(0, commands.length - 1))];
  const close = (): void => {
    onClose();
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const activate = (command = activeCommand, trigger?: HTMLElement): void => {
    if (!command) return;
    onCommand(command.id, trigger ?? inputRef.current ?? undefined);
    if (command.enabled && command.id !== "palette.open") close();
  };

  return (
    <div className="builder-command-palette__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div
        ref={dialogRef}
        className="builder-command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="builder-command-palette-title"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((value) => commands.length === 0 ? 0 : (value + 1) % commands.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((value) => commands.length === 0 ? 0 : (value - 1 + commands.length) % commands.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            activate();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Tab") {
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])');
            if (!focusable || focusable.length === 0) return;
            const first = focusable[0] as HTMLElement;
            const last = focusable[focusable.length - 1] as HTMLElement;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="builder-command-palette__heading">
          <h2 id="builder-command-palette-title">Commands</h2>
          <button type="button" aria-label="Close commands" onClick={close}>Close</button>
        </div>
        <input
          ref={inputRef}
          className="builder-command-palette__search"
          type="search"
          role="combobox"
          aria-controls="builder-command-listbox"
          aria-expanded="true"
          aria-activedescendant={activeCommand ? `builder-command-${activeCommand.id}` : undefined}
          aria-label="Search commands"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <div id="builder-command-listbox" className="builder-command-palette__list" role="listbox" aria-label="Available commands">
          {commands.map((command, index) => (
            <button
              key={command.id}
              id={`builder-command-${command.id}`}
              type="button"
              role="option"
              // Options are managed by the combobox input's activedescendant;
              // keeping them out of the Tab order stops focus and selection
              // from diverging. Mouse activation still works.
              tabIndex={-1}
              aria-selected={index === active}
              aria-disabled={!command.enabled}
              className="builder-command-palette__option"
              onMouseEnter={() => setActive(index)}
              onClick={(event) => activate(command, event.currentTarget)}
            >
              <span>
                <strong>{command.label}</strong>
                <small>{command.enabled ? command.description : command.reason}</small>
              </span>
              {command.shortcutLabel && <kbd>{command.shortcutLabel}</kbd>}
            </button>
          ))}
          {commands.length === 0 && <p className="builder-command-palette__empty">No matching commands.</p>}
        </div>
      </div>
    </div>
  );
}
