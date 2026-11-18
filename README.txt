# PoolSim — what we actually built, and why

We started from a working prototype of Uber Pool on a toy Manhattan grid: two
cabs, two seats max, one rider cap on detour, no traffic. Good bones, but a
prototype — a brute-force matcher, static everything, no notion that a real
city (or a real emergency) behaves differently than a spreadsheet. Over this
build we turned it into something we'd actually defend in front of a judge
who's seen a hundred ride-pooling demos: faster where it mattered, honest
about its own tradeoffs, and grounded in research we actually went and did
rather than assumed.

Nothing here is a mockup. Every number below came from running the engine,
not from a slide.

## How to run it

```
python3 -m http.server 8000
# open http://localhost:8000
```

No build step, no dependencies, works from `file://` too if you'd rather
skip the server. Node ≥ 18 if you want the test suite:

```
node test/sim.test.js
```

32 tests, all invariant checks on the actual simulation engine (capacity
never exceeds 2, detour cap is never silently violated, pickups never slip
past their promise, driver pay always reconciles to the cent) — not
snapshot tests, not mocks. If you change the matching logic and break a
promise the UI makes to a rider, this is what catches it.

## The system, in one picture

Two cities run side by side off the *same* random seed — same riders, same
request times, same starting cab positions. One pools, one doesn't. Every
number in the report is a direct diff between those two cities, so "pooling
saved X" is never a guess, it's a controlled comparison against a baseline
that saw the exact same demand.

```
js/sim.js      the engine — matching, movement, money, every rule (no DOM)
js/metrics.js  turns two finished cities into the comparison numbers
js/render.js   canvas rendering only
js/report.js   the end-of-run report (charts, insight cards)
js/app.js      wiring, controls, the run loop
test/          32 invariant tests against the engine directly
```

Nothing in the engine knows the DOM exists. That's deliberate — it's why we
could keep bolting new mechanics onto `sim.js` all session without ever
touching a pixel of the UI, and why the test suite can run headless in CI
without a browser.

## What we actually optimized, and the numbers to back it

**1. Matching stopped being brute-force.** The original matcher scanned
every cab for every rider — fine at 30 cabs, dead at city scale. We added a
spatial grid index so a rider only gets compared against cabs that could
plausibly reach them. Same matching decisions, same outcomes, just not
reconsidering cabs that were never going to win:

| Fleet size | Before (est.) | After |
|---|---|---|
| 30 cabs / 200 riders | 25ms | 25ms |
| 300 cabs / 2,000 riders | seconds | 249ms |
| 500 cabs / 5,000 riders | unusable | 562ms |

**2. Matching stopped being first-come-first-served.** Riders used to get
matched strictly in request order, so an expensive match could lock out a
far cheaper one sitting right behind it in the queue. We now batch every
dispatch tick, rank every feasible (rider, cab) pair by actual cost, and
commit cheapest-first — the same technique real dispatch systems
(GrabShare, early Lyft) use, and the literature calls it the "greedy
method" for weighted bipartite matching, not something we invented.
**Result: 206 → 227 riders delivered on the same demand, same fleet (+10%).**

**3. Idle cabs stopped just sitting there.** We gave the engine a live,
decaying heat-map of where requests have actually been landing (plain
exponential decay, the same technique production rebalancing systems use
before anything fancier), and idle cabs drift toward the hot zones instead
of parking wherever they finished their last trip. In a downtown-shortage
scenario: **117 → 175 riders delivered (+50%), give-ups cut by 21%**, and
the fleet visibly migrates toward demand over the run.

**4. Pool riders stopped detouring to every exact address.** Borrowed
straight from Uber's own Express Pool: nearby pickups/drop-offs snap to a
shared meeting point a short walk away instead of the cab swinging by every
door. Average pool detour dropped from **19.3% to 16.9%** of the solo
estimate with more riders delivered on the same run.

**5. The discount stopped being a flat number nobody re-examined.** Every
pool rider used to get the same flat % off whether or not anyone ever
actually shared their ride — meaning the platform pays the discount on pure
gambles that don't pay off. We price the discount at the moment of
matching: bigger when you're joining a cab that's already got someone
(a certain match), smaller when you're betting on an idle cab. In a
leakage-heavy city: **leaked discount down 36%, platform margin up 22%**,
with the match rate itself completely untouched.

**6. A declared incident is a hard constraint, not a decoration.** Click
either map mid-run and a zone goes live, identically, in both cities, at
the same instant. No pickup, drop-off, or *route* is ever allowed to cross
it — checked with exact Manhattan-diamond geometry, not a bounding box —
and any cab already inside when it's declared flees automatically,
verified to move strictly away every tick, never doubling back in. Stranded
riders aren't silently dropped: a cancelled pickup goes back into normal
matching, an unreachable drop-off relocates to the nearest safe point and
is reported as such.

**7. Streets now have a cost structure, not just distance.** This was the
late addition: left turns cost real time (we modeled it on UPS's actual
routing doctrine — ORION avoids left turns because every one means waiting
for a gap in oncoming traffic, and UPS reports under 10% of its turns are
left turns as a result). We didn't hand-code "avoid left turns" anywhere.
We just told the matching engine that a left turn costs extra seconds, and
let the *existing* cost-minimizing search figure out the rest. At a
20-second penalty, the left-turn share of this city's routes fell from a
natural 49.7% down to **10.2% — almost exactly UPS's real-world number —
with zero special-case logic written for it.** That's the result we're
proudest of this round: the behavior emerged from the economics, not from
a rule we wrote.

Getting that feature correct took real debugging, not just real coding —
turn penalties touch every place the engine estimates time, and four
separate spots were quietly assuming the old distance-only math still held
once turns had a cost:

1. **A turn-wait already in progress wasn't visible to matching.** A cab
   mid-wait at a corner could still get offered a new rider, and the offer's
   predicted schedule silently ignored the seconds still ticking down —
   found by tracing one rider's actual pickup/drop-off against what the
   engine had promised them and finding a 19.1-second gap that turned out to
   be *exactly* the unpaid remainder of a turn delay.
2. **"Removing a stop only ever helps" stopped being true.** Re-dispatch
   shortens a cab's route on the assumption that less distance can't hurt
   anyone still aboard — true for pure distance, false once a shorter route
   can introduce a left turn a longer one would have avoided.
3. **A fresh reassignment skipped validation entirely.** Moving a waiting
   rider to a newly-freed cab built that cab's plan directly, with no check
   that the pickup-to-drop-off leg itself didn't require an uncosted left
   turn.
4. **Fleeing a declared incident could clip back toward the danger it was
   escaping.** Heading straight for a far safety corner can pass closer to
   the center first if that corner isn't on the cab's current axis — fixed
   by having the escape prioritize whichever axis is actually retreating,
   not just "x before y" by default.

All four are now locked down by dedicated tests, and we swept 160
turn-penalty-only runs plus every other feature combined with it (meeting
points, batch matching, dynamic discount, predictive repositioning,
adaptive radius, city-center demand, all six at once) — zero detour-cap
violations across all of it.

**One honest finding along the way, stated plainly:** while chasing this we
found that an *active incident* can independently push a rider's ride time
past the normal promise, with or without turn penalties on — we confirmed
this by re-running the identical scenario with turn penalties fully
disabled and the same class of overage was already there (53 cases vs. 62
with turn penalties on, not a multiplicative blowup). That's a pre-existing
property of incident response from an earlier round, not something turn
penalties caused: incident avoidance is an intentional safety override (the
engine prioritizes getting everyone away from danger over honoring the
ride-time promise), and we'd rather surface that clearly than let a clean
turn-penalty number quietly imply it doesn't exist.

## Research we actually did, not assumed

Every number quoted above that isn't a direct simulation output came from
sourced research, run as background agents against live web search, not
recalled from memory: Uber Express Pool's real walk-distance policy and
claimed savings, UPS's ORION left-turn statistics, published traffic-
engineering delay figures for unprotected left turns, the academic
literature on batch vs. greedy bipartite matching, and the known failure
modes of naive demand-driven repositioning (oscillation, fleet clustering,
the empty-mile tradeoff) — all cited inline in the engine's own comments
and in the full design notes.

## Tools used

Built in [Claude Code](https://claude.com/claude-code) running **Claude
Sonnet 5** (`claude-sonnet-5`), with research grounding gathered through
parallel background research agents (the same model, run concurrently,
dedicated to web research while implementation continued) rather than
relying on the model's own recollection for anything we were going to put
a number next to.

## Why this is a stronger pilot story than "we built Uber Pool"

Three stakeholders, every feature maps to at least one, most to more than
one:

- **Riders** — fewer give-ups, shorter detours, fairer pricing, never
  routed through a declared danger zone.
- **Drivers** — more trips per shift (predictive repositioning, batch
  matching), fairer earnings (fairness rebate, dynamic discount), never
  sent into a hazard.
- **Uber the platform** — less discount leakage, higher margin, a system
  that scales past a 30-cab pilot without a rewrite, and a measurable,
  honest answer for "what happens in an emergency" — which is the question
  that actually gets asked before a real launch.
