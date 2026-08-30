"use client";

import { useEffect, type RefObject } from "react";
import {
  commandForShortcut,
  type BuilderCommandId,
} from "@/lib/flow/builder-command-registry";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

export interface BuilderShortcutOptions {
  readonly scopeRef: RefObject<HTMLElement | null>;
  readonly onCommand: (id: BuilderCommandId, trigger?: HTMLElement) => void;
  readonly onNativeCopy: (event: ClipboardEvent) => void;
  readonly onNativePaste: (event: ClipboardEvent) => void;
}

export function useBuilderShortcuts({
  scopeRef,
  onCommand,
  onNativeCopy,
  onNativePaste,
}: BuilderShortcutOptions): void {
  useEffect(() => {
    const inScope = (event: Event): boolean => {
      const scope = scopeRef.current;
      return Boolean(scope && event.target instanceof Node && scope.contains(event.target));
    };
    const keydown = (event: KeyboardEvent): void => {
      if (!inScope(event) || isEditableTarget(event.target)) return;
      const command = commandForShortcut(event);
      if (!command) return;
      if (command === "selection.copy" || command === "selection.paste") {
        // Let the browser emit the native copy/paste event; those handlers are primary.
        return;
      }
      event.preventDefault();
      onCommand(command, event.target instanceof HTMLElement ? event.target : undefined);
    };
    const copy = (event: ClipboardEvent): void => {
      if (!inScope(event) || isEditableTarget(event.target)) return;
      onNativeCopy(event);
    };
    const paste = (event: ClipboardEvent): void => {
      if (!inScope(event) || isEditableTarget(event.target)) return;
      onNativePaste(event);
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste);
    };
  }, [scopeRef, onCommand, onNativeCopy, onNativePaste]);
}
