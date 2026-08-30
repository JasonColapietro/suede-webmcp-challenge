"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import {
  BUILD_SETTINGS,
  buildSettingHref,
  type BuildSettingId,
} from "@/lib/build-settings";

export type ModeSwitchSetting = BuildSettingId;

interface ModeSwitchProps {
  active: ModeSwitchSetting;
  flowId?: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

export default function ModeSwitch({ active, flowId, onNavigate }: ModeSwitchProps): React.JSX.Element {
  // The canvas owns the raw flow id; the catalog takes it already encoded so
  // the encoding lives next to the route that produced it.
  const encodedFlowId = flowId ? encodeURIComponent(flowId) : null;

  return (
    <nav aria-label="Setting" className="mode-switch">
      {BUILD_SETTINGS.map((s) => {
        const href = buildSettingHref(s.id, encodedFlowId);
        const isActive = s.id === active;

        if (isActive) {
          return (
            <span
              key={s.id}
              className="mode-switch__item"
              data-active="true"
              aria-current="page"
              title={s.blurb}
            >
              {s.label}
            </span>
          );
        }

        return (
          <Link
            key={s.id}
            href={href}
            className="mode-switch__item"
            title={s.blurb}
            onClick={(event) => {
              if (!onNavigate) return;
              event.preventDefault();
              onNavigate(href, event);
            }}
            onAuxClick={(event) => {
              if (!onNavigate) return;
              event.preventDefault();
              onNavigate(href, event);
            }}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
