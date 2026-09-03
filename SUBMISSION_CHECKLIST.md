# WebMCP Challenge submission checklist

Updated September 3, 2026 UTC. Deadline: September 3 at 1:00 PM PDT / 4:00 PM EDT.

## Completed and verified

- [x] Existing application meaningfully extended with WebMCP after August 25.
- [x] Registration accepts synchronous and Promise-returning browser APIs.
- [x] Regression test registers all four tools when `registerTool` returns undefined.
- [x] All 71 focused WebMCP tests pass; current runtime source has passing CI.
- [x] Fresh in-app browser tabs expose four tools on `/agents` and the PO Match Gate listing.
- [x] `find_services`, `get_service`, and a zero-cost synthetic `preview_service` work.
- [x] `buy_service` was not called.
- [x] Public runnable source and MIT license; challenge history preserved.
- [x] Description explains six curated WebMCP services from the 31-listing directory.
- [x] Existing narrated demo recorded and uploaded; current submitted video is
      https://youtu.be/ZR1At7lX6-E.
- [x] Existing Devpost entry joined, described, linked, and submitted.
      Live form readback: **SUBMITTED, 5/5 steps done**, submission `1165561`.
- [x] Entrant fields read back as Individual / United States; organization field blank.
- [x] Testing instructions contain exact synthetic inputs, receipt expectations,
      and an explicit stop before purchase.
- [x] Dedicated challenge deployment built from `7234b99`; release branch exists.
- [x] Both release branches locked, with administrator enforcement and no
      force pushes or deletion.
- [x] Two-minute recut rendered at 1920×1080 with H.264 video and AAC audio;
      composition runtime, layout, and contrast checks passed.
- [x] Challenge domain is assigned to the release branch, so normal production
      branch deploys do not own its automatic assignment.

## Remaining before final freeze

- [ ] Add the GoDaddy CNAME for `webmcp.suedeai.ai`; finish certificate and alias setup.
- [ ] Verify logged-out public access and all four tools on the challenge domain.
- [ ] Verify discovery, contract, and synthetic preview on that exact domain.
- [ ] Replace both Devpost live-URL fields and the URL in testing instructions.
- [ ] Verify the final domain end card before publishing the prepared recut.
- [ ] Upload the recut, verify public playback, and replace the Devpost video URL.
- [ ] Record final deployment and video evidence, then freeze the public repository.
- [ ] Keep submitted code, video, live deployment, and the six curated service
      contracts unchanged through September 21 at 5:00 PM PDT.

The deployed release shares the existing hosted database. A fixed source
branch alone does not freeze catalog edits or published flow changes. See
`CHALLENGE_EVIDENCE.md` for the precise deployment state and remaining gate.

Do not resubmit or create a duplicate Devpost project. The entry is already
submitted; only its authorized pre-deadline corrections remain.
