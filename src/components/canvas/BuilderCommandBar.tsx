"use client";

import React, { forwardRef } from "react";
import {
  commandState,
  type BuilderCommandContext,
  type BuilderCommandId,
} from "@/lib/flow/builder-command-registry";

const VISIBLE: readonly BuilderCommandId[] = [
  "history.undo",
  "history.redo",
  "selection.delete",
  "selection.duplicate",
  "graph.auto-layout",
  "palette.open",
];

export interface BuilderCommandBarProps {
  readonly context: BuilderCommandContext;
  readonly onCommand: (id: BuilderCommandId, trigger?: HTMLElement) => void;
}

const BuilderCommandBar = forwardRef<HTMLButtonElement, BuilderCommandBarProps>(
  function BuilderCommandBar({ context, onCommand }, commandsRef): React.JSX.Element {
    return (
      <div className="builder-command-bar" role="toolbar" aria-label="Builder commands">
        {VISIBLE.map((id) => {
          const command = commandState(id, context);
          const reason = command.reason ?? `${command.description}${command.shortcutLabel ? ` ${command.shortcutLabel}` : ""}`;
          return (
            <button
              key={id}
              ref={id === "palette.open" ? commandsRef : undefined}
              type="button"
              className={id === "selection.delete"
                ? "builder-command-bar__button builder-command-bar__button--danger"
                : "builder-command-bar__button"}
              aria-disabled={!command.enabled}
              aria-label={!command.enabled && command.reason
                ? `${command.label}. ${command.reason}`
                : command.shortcutLabel
                  ? `${command.label}, ${command.shortcutLabel}`
                  : command.label}
              title={reason}
              onClick={(event) => onCommand(id, event.currentTarget)}
            >
              {command.label}
            </button>
          );
        })}
      </div>
    );
  },
);

export default BuilderCommandBar;
