# Changes

## October 18, 2026 — Proactive home-care guidance

Guide version: `2026-10-16.proactive.4`.

- Known models, including those extracted from receipts, trigger applicable manual research and useful care guidance within the user's scope.
- Reported problems trigger source-grounded troubleshooting, safe next checks and advice matched to the owner's time and ability.
- Agents carry unfinished work forward, retain unknown answers and resume directly without redundant permission questions.
- The CLI skill is self-contained, and the starter prompt permits public model research while preserving explicit user limits.

Validated through three synthetic conversational rounds in Muse with revisions after each round. A final resume prompted pending LG research automatically, but produced manufacturer references rather than saved manual PDFs. These were coached tests in one chat; fresh-session consistency and real-home repair outcomes remain unverified. Local public-package tests use temporary databases.

All research and reasoning remain in the client agent. No server inference, background monitoring, booking or storage migration was added.
