# Suede Agent Studio iOS

Capacitor wrap of `agents.suedeai.ai`. Mirrors `Suede-AI-App/ios-app/` (Suede Social),
minus Sign in with Apple — the studio uses per-browser cookie identity, no account login.

## Setup

```bash
cd ~/Documents/agentix/ios-app
npm install
npx cap sync ios
npx cap open ios
```

## Identity

- App Store name: Suede Agent Studio
- Device display name: Suede Agents
- Bundle ID: `ai.suede.agents`
- URL scheme: `suedeagents`

## Workflow notes

- Web/JS fixes ship by deploying the web app (`vercel --prod` from the agentix repo
  root) — the shell loads the live site, no app update needed.
- Native changes (config, icons, plugins) need a rebuild + App Store resubmission.
- Icons/splash regenerate from `assets/` via `npm run generate-assets`, then
  `npx cap sync ios`.
