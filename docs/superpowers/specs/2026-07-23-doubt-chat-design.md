# AI Doubt-Solving Chat — Simulator Design

Fake-data demo of spec section 2.1, added as new section to `student-dashboard.html`.

## Scope
- New sidebar nav item (chat icon) toggles a new `#doubtchat` section, using existing section-toggle JS pattern.
- Client-side only: no backend, no persistence across reload.

## Interaction
- 3-4 hardcoded Q&A pairs, one subject (Data Structures), matched by keyword against user input.
- No keyword match → honest fallback message ("no verified content on that yet").
- Tier badge per AI reply: "Tier 1 · Fast" (short input) or "Tier 2 · Deep" (long/complex input).
- Tier 2 replies show a brief thinking-dots animation before rendering.

## AI reply format
Each AI bubble renders three labeled blocks: Explanation → Key Concept → Example.

## Visual
Reuses existing tokens (--cream, --ink, --pink, --blue, --yellow, radii, shadow). Student messages right-aligned accent bubble; AI messages left-aligned white card with tier badge.
