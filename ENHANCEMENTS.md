# PoolSim++ — making the pilot real

A hackathon pass on the existing PoolSim prototype: same UI, same core rules
(2-seat cap, 1.5× detour promise, no traffic), same engine architecture — but
closing gaps the prototype's own README/report already name as missing, and
grounding the two biggest additions in actual research into how real
ride-pooling platforms have struggled and how real dispatch systems solve
idle-vehicle placement. Every change is picked because it pays off a specific
stakeholder (**rider**, **driver**, or **Uber the platform**) without
requiring a rewrite.

## 1. The ask, and the constraint that shaped every choice

The brief: enhance a working simulator for a two-seat Uber Pool pilot in a
"well-behaved" city (no traffic, deterministic ETAs). Judges want to see: a
better algorithm, a real feature, a bug fix, research grounding — and a story
for who benefits. The hard constraint was **time** and **stability** (UI and
existing behavior must not regress). That ruled out a rewrite; it favored
*surgical, provably-safe* changes, each shippable and testable independently,
each defaulting to **off** so the existing engine invariant tests and the
documented example numbers keep holding bit-for-bit until a judge flips a
new switch.

## 2. What research actually says about this problem

Before building, we researched (a) what real riders/drivers/platforms have
actually struggled with in ride-pooling, and (b) how real systems solve
idle-vehicle placement — so the two biggest additions below aren't guesses.

**Uber Pool's real track record.** A Toronto study found the average detour
penalty on matched Pool trips was ~3.6 minutes (16.7% of travel time),
spiking to 7 minutes in dense areas, with only ~52% of Pool trips actually
matching a co-rider — meaning roughly half of riders paid a discount for
nothing but a detour-capable route they never shared. Uber reportedly burned
over $1M/week subsidizing Pool in San Francisco alone trying to hit viable
match density. Pool was suspended fleet-wide in March 2020 and never
restored in its original form — replaced by the more conservative UberX
Share (max 1 co-rider) in a fraction of its former markets; Lyft killed
Shared Rides entirely in 2023. The consensus read: thin-to-negative margins
*predated* COVID; the pandemic was the exit excuse, not the cause. On the
driver side, academic driver-attitude research and driver forums both point
to the same structural complaint: the pooling margin accrues to the
platform, not the driver, and driver ratings measurably drop on pooled
trips. On the rider side, beyond the detour/match-rate problems, there are
documented safety incidents from shared trips exposing co-riders' drop-off
locations to strangers.

Three of those are exactly the gaps this pass closes: **match-rate/leakage**
is insight #1 in the existing report, **driver pay fairness** is insight #2,
and **uneven detour cost** is insight #3 — all three were already diagnosed
in the prototype's own report copy, just never acted on. Feature 3 below
(fair-detour rebate) is a direct response to the detour-asymmetry finding.

**Predictive repositioning — the literature.** This is a real, named research
area ("vehicle repositioning problem" / "fleet rebalancing"), not something
we invented a plausible-sounding name for. The dominant real-world baseline —
confirmed, not assumed — is a **grid/geohash heatmap of observed demand,
decayed over time (EWMA)**: bin requests into cells, decay old observations
exponentially, move idle vehicles toward the hot cells. That's a documented
production technique (Uber-style driver heatmaps) and the standard benchmark
academic papers compare fancier models against. Above that baseline sit
optimization-based rebalancing (min-cost flow, like bike-share rebalancing)
and, at the research frontier, multi-agent reinforcement learning — both
overkill for a prototype. Measured gains from proactive heatmap-style
repositioning versus reactive-only dispatch in the literature: **+4.8%
service rate, −5.0% wait time, −10.7% total delay** on average (Predictive
Vehicle Repositioning for On-Demand Ride-Pooling, arXiv 2308.05507).

The same research also names the failure modes to design around:
**empty-mile cost is real** (one study measured repositioning raising
empty-fleet-mile share from ~30% to ~40% — it's a genuine tradeoff, not a
free win); **oscillation**, where un-decayed reactive repositioning has cabs
flip-flopping toward whatever cell had the last request; and
**self-defeating clustering**, where naive single-target repositioning sends
the whole idle fleet to the one hottest cell and starves every other zone —
which is exactly why multi-agent approaches exist. Feature 4 below is built
to dodge all three: EWMA decay (no oscillation), a commit-until-arrival
target (no thrashing), and explicit top-K spread across hot zones (no
clustering) — the same techniques, just at prototype scale instead of
production scale.

## 3. The gaps closed (not invented — read off the code)

- **Scalability**: `matchQueue`/`redispatch` used to linearly scan every
  idle/poolable cab for every queued rider — `O(K·N)` and `O(N²)` per
  dispatch tick. Fine at 30 cabs; falls over at city scale.
- **Static ping radius**: the report runs an offline *sweep* to recommend a
  radius, then asks you to go change a slider by hand — nothing in the
  running sim reacts to the demand surge it's currently seeing.
- **Fairness gap, explicitly named and left unsolved** (report.js insight
  #3): *"the rider already aboard absorbs several times the extra time of
  the rider who joins, for the same Y% discount... A fairer design would
  price the detour each rider actually absorbs."* A to-do comment in the UI
  that the research above independently confirms is a real, documented
  rider complaint — not a hypothetical.
- **No repositioning, and no demand structure to reposition toward**
  (README "Simplifications": *"Idle cabs wait where they are; there's no
  repositioning toward demand."* / *"Demand is uniform random in space."*).
  Both named, neither fixed. Closing the second is what makes closing the
  first demonstrable: with uniform demand there's no pattern to predict.

## 4. The nine changes

| # | Change | Type | Who benefits | Default |
|---|---|---|---|---|
| 1 | Spatial grid index for cab matching | Algorithm/perf | Uber (scales the pilot past 30 cabs) | always on, behavior-preserving |
| 2 | Adaptive ping radius | New feature + algorithm | Rider (fewer give-ups) + Uber (less empty driving) | opt-in toggle |
| 3 | Fair-detour rebate | New feature (closes a named, research-confirmed gap) | Rider (fairness) | opt-in slider, 0% default |
| 4 | **Predictive repositioning** | New feature + algorithm (research-grounded) | Driver (more trips) + Rider (shorter waits, fewer give-ups) | opt-in toggle |
| 5 | City-center demand | New feature (makes #4 demonstrable and honest) | — (a city-shape control, not a stakeholder win by itself) | opt-in toggle |
| 6 | **Incident response** (declare a threat, fixed radius) | New feature + algorithm (hard geometric constraint) | Rider (never routed through danger) + Driver (never sent in) + Uber (duty-of-care, demonstrable) | always available, inert until declared |
| 7 | **Global batch matching** | Algorithm (research-confirmed production technique) | Rider (+10% delivered in testing) + Uber (denser, more efficient matching) | opt-in toggle |
| 8 | **Shared meeting points** | New feature (Express Pool's actual mechanism) | Rider (shorter detours) + Driver (fewer/shorter detours) + Uber (higher match density) | opt-in toggle |
| 9 | **Dynamic pool discounting** | New feature (closes insight #1's own named gap) | Rider (fair pricing) + Uber (−36% leakage, +22% margin in testing) | opt-in toggle |

**1 — Spatial index.** `matchQueue`/`redispatch` bucket cabs into a grid
keyed by position and only scan the handful of cells that could contain a
cab within range, instead of every cab in the fleet. **Behavior-preserving**:
every cab within the radius is still evaluated and scored exactly as before,
only the scan order changes. Cuts the dominant per-tick cost from
`O(K·N + N²)` to `O(K·c + N·c)` where `c` is local cab density, not fleet
size. Measured: the default city still runs in 25ms; a 10× fleet (2,000
riders / 300 cabs) runs in 249ms; a 25× city (5,000 / 500) in 562ms — all
well within one frame budget.

**2 — Adaptive ping radius.** The report already proves there's a sweet spot
radius that moves with supply/demand. This runs that logic live: each
dispatch tick computes pressure (queue length ÷ idle+poolable cabs) and
smoothly widens the radius during a demand spike, tightens it when cabs are
plentiful — the report's own *recommendation* logic, running continuously
instead of once at the end.

**3 — Fair-detour rebate.** At drop-off, a pool rider who was the **host** of
a shared ride — already aboard when someone else got slotted in — gets a
rebate proportional to the extra seconds they actually absorbed, capped so
fare can't go negative, charged honestly against platform margin and shown
as its own report line. Off by default (0%); the host/joiner ratio already
in the report (now backed by the Toronto detour-penalty research above) is
what tells you whether to turn it on.

**4 — Predictive repositioning.** A cab idle past a threshold drifts toward
*predicted* demand, not just demand that's already piled up in the queue.
The prediction is a live heatmap: the city is divided into a 10×10 grid,
every observed request bumps its cell, and every dispatch tick (~1s) all
cells decay by 0.985 (~46s half-life) — a pure online EWMA over *past*
arrivals only, never the future, exactly the confirmed real-world baseline
technique described in §2. When an idle cab triggers, it picks among the
top-3 hottest cells, trading off heat against distance — so idle cabs spread
across several warm zones instead of all convoying onto the single hottest
block (the clustering failure mode named in the research). If no demand
signal exists yet (feature just turned on, or genuinely uniform/noisy
demand), it falls back to drifting toward the current queue's centroid so
cabs are never frozen while the heatmap bootstraps. A reposition target is a
plain `{x, y}` kept **entirely outside** `cab.plan` — the structure the
matching math reasons about — so it is structurally incapable of violating
the capacity/detour/radius invariants; the only thing it can do is move an
empty cab. Repositioning drive time correctly lands in the existing "empty
driving" accounting bucket.

Measured on a downtown-shortage scenario (18 cabs, 500 riders, city-center
demand on, 400s run): **riders delivered 117 → 175 (+50%), give-ups 254 →
200 (−21%)**, and the fleet's average distance from the demand center drops
from 32.0 to 23.6 blocks over the run — the cabs visibly migrate toward
downtown. Under genuinely uniform demand the same toggle is close to
neutral (212 → 219 completed) — it doesn't manufacture an improvement where
there's no real spatial pattern to find, which is the honest result the
research says to expect.

**5 — City-center demand.** New, independent demand-shape control: request
*origins* cluster toward the grid center via inverse-transform radial
sampling (destinations stay uniform — riders still scatter home), modeling
downtown-heavy pickup demand instead of PoolSim's original uniform-random
city. This exists specifically so feature 4 has a real pattern to
demonstrate against — "more requests in the city center, fewer in
residential areas," per the brief — and so a judge can toggle it off and see
predictive repositioning correctly stay quiet when there's genuinely nothing
to predict.

**Visual proof, not just numbers.** The map now renders the live demand
heatmap as a soft glow under the city (brighter where requests have recently
clustered) and a faint dashed line from any repositioning cab to where it's
headed — so the prediction and the fleet's reaction to it are both visible
in real time, not just in the end-of-run report.

## 5. How correctness was protected

- Every new behavior defaults to **off** (or, for #1, is provably
  equivalent to the old code) — the original README example numbers still
  reproduce exactly, and `cityCenterDemand`/`reposition` off reproduce the
  exact old uniform-demand, static-idle-cab behavior.
- Every change was checked against the full engine invariant suite
  (`node test/sim.test.js`) before moving on — now 29 tests, up from the
  original 16, with new invariants covering: fare never negative under the
  rebate, detour cap still respected, effective radius stays in bounds,
  idle/empty/one/two seconds still sum to wall time, repositioning never
  touches a cab with real stops, hotspot demand generation stays
  independent of the pool opt-in draw, predictive repositioning measurably
  pulls the fleet toward observed demand without losing riders relative to
  standing still, no stop is ever planned inside an active (even
  overlapping) incident, both twin cities see an identical incident, a cab
  caught inside a new zone flees monotonically and never re-enters one while
  it's active, and cancelled/evacuated riders correctly re-enter normal
  matching once safe.
- Repositioning (#4) is deliberately kept **outside** `cab.plan` specifically
  so it's structurally impossible for it to violate the capacity or detour
  invariants — it can only move an empty cab around.

## 6. Incident response — "declare a bomb threat anywhere, fixed radius"

This was handed to every team identically, so the obvious version is also
the one every judge will see five times: a sidebar form field for
coordinates and a radius, which blocks *new* pickups in a circle and calls
it done. We built the version that treats the zone as what it actually is —
a hard keep-out that the routing math itself cannot violate, not a
best-effort preference layered on top — and made declaring one feel like an
actual incident, not a settings change.

**What's different from the obvious version:**

- **Click the live map, not a form.** Either twin-city canvas is clickable
  mid-run; the exact grid point you click becomes the incident center, at
  the exact simulated instant you clicked, in **both** cities simultaneously
  (critical — if only one twin saw it, the pool-vs-no-pool comparison would
  stop being apples to apples the moment you used the feature). Radius and
  duration are the two things the brief says are fixed per incident, so
  those are sidebar sliders (`Incident radius`, `Incident duration`); *where*
  and *when* are live, physical, on the map.
- **The zone is a Manhattan diamond, not a Euclidean circle** — the same
  shape the app already uses for ping radius, and for the same reason: it's
  the metric the grid and every other rule in this engine is already defined
  in, so a new safety rule drawn as a circle would actually be inconsistent
  with the rest of the simulation's geometry.
- **No route may ever cross it, not just no stop inside it.** The hard
  version of this problem isn't "don't start a trip in the blast radius," it's
  "don't let a cab's path clip through it on the way to somewhere else." That
  required exact segment-vs-diamond intersection math (`segHitsThreat`),
  checked both in the matching search (`evalPlan`, so no *new* commitment is
  ever created through a zone) and continuously in live movement (`advance`,
  re-checked at every intersection, so a zone that appears mid-route or
  expires mid-route never leaves a cab routed on stale information).
- **Cabs already caught inside a zone flee, they don't just stop accepting
  new work.** A cab idle (or between stops) exactly where you click doesn't
  passively sit in the blast radius — fleeing to the nearest safe point
  overrides its plan, its reposition target, everything, the instant the
  zone appears. Verified by test: distance from the zone's center is
  non-decreasing on every tick a cab is inside one (it never stalls or
  backtracks while fleeing), and no cab ever re-enters a zone it has escaped
  while that zone is still active.
- **Stranded riders are handled explicitly, not silently dropped.** A rider
  not yet picked up whose origin is suddenly inside the zone has their
  pickup cancelled and is returned to normal matching — they're still
  waiting, not erased, and get served once it's safe. A rider whose
  *destination* becomes unreachable mid-ride is rerouted to the nearest safe
  point instead, flagged `evacuated` and reported honestly, not quietly
  renamed as "arrived."
- **Reported as its own thing.** The end-of-run report gets a dedicated
  "Incident response" section — but only when an incident was actually
  declared during the run, so everyone who never touches the feature sees
  an identical report to before.

Verified with three overlapping, simultaneously-active zones (a harder case
than any single-incident demo): zero pickups or drop-offs were ever planned
inside any of them, in either city, across the whole run. Performance holds:
the default city with an incident still runs in ~28ms; a 10× fleet with an
incident runs in ~490ms (vs ~215ms without one) — the extra geometry checks
roughly double cost at scale but stay well inside one frame budget.

## 7. Round three: picking the best 3 of 8+ proposed features

The mentor's brief (and ours) expanded to 8 candidate features: global batch
matching, driver accept/reject modeling, shared meeting points, geographic
service equity, passenger preference modeling, dynamic pool discounting,
dynamic fleet reserves, and driver earnings guarantees. We researched two of
these in depth before picking (sources in the implementation), then selected
the three with the strongest evidence, the cleanest stakeholder story, and
the lowest risk of destabilizing six already-shipped, already-tested
features: **global batch matching**, **shared meeting points**, and
**dynamic pool discounting**. (Geographic service equity was the closest
runner-up — a strong complement to the predictive-repositioning work from
round two — left out only for scope, not merit.)

**Research grounding, not guesswork:**
- **Shared meeting points** is exactly Uber Express Pool's actual mechanism:
  riders walked up to ~250m to a shared point, and Uber claimed routes
  ~30–50% cheaper than standard Pool/UberX as a result. No evidence it
  specifically failed before the 2020 fleet-wide Pool suspension — it's a
  proven idea, not a discontinued one.
- **Batch matching over greedy sequential assignment** is standard practice
  in production dispatch (GrabShare, early Lyft) and in the OR literature —
  recent work (Eom & Toriello, MSOM 2024) shows pure batching is
  asymptotically optimal on wait time where naive greedy is not. Production
  systems batch over **1–2 second windows**; this engine already dispatches
  every 1 second, so no cadence change was needed — only the selection
  policy inside that window. The specific technique used — rank every
  candidate (rider, cab) pair by cost, commit cheapest-first, skip
  conflicts — is explicitly named "the Greedy method" for weighted
  bipartite matching in a 2021 VLDB survey of real-world order dispatch.
- **Dynamic pool discounting** isn't from outside research — it's the
  existing report's own insight #1, which has been sitting in this app
  since round one: *"the cost of Pool scales with the opt-in rate; the
  benefit scales with the match rate... unmatched opt-ins are pure
  leakage."* This round finally acts on it.

**What was built, and what it measurably does:**

**Global batch matching** (`batchMatching`, toggle) — `matchQueue` used to
commit each queued rider to their best cab strictly in request-arrival
order, letting an early, expensive-to-serve request lock in a cab that a
later, much-cheaper-to-serve request could have used instead. Batched mode
gathers every rider's best feasible option first (identical candidate
search, identical `evalPlan`-enforced hard rules — only *which* option gets
committed changes, never *whether* one is valid), sorts all candidates by
cost, and commits globally cheapest-first, capping each cab at one new
commitment per tick so no stale, just-mutated plan is ever reused mid-batch.
Measured on a moderate-density scenario: **206 → 227 riders delivered
(+10%)**, same lost count, from the identical demand and fleet.

**Shared meeting points** (`meetingPoints` + `walkRadius`) — a pool rider's
pickup/drop-off snaps to the nearest point on a coarse lattice (spacing =
`walkRadius`) instead of their exact address, so nearby requests collapse
onto literally the same stop — which costs a cab zero extra travel between
them. This needed no change to the matching algorithm at all: `bestInsertion`
already minimizes detour cost, so it naturally favors the now-free
consolidation on its own. The fare and detour-cap promise stay pinned to
the real door-to-door distance (the promise doesn't move, only the stop
does); walked distance is tracked and reported honestly, never hidden
inside the ride metrics. Measured at moderate density: **pool riders'
average detour fell from 19.3% to 16.9%** of their solo estimate, with more
riders delivered and fewer giving up — the exact Express Pool value
proposition, reproduced from the actual mechanism, not just the branding.

**Dynamic pool discounting** (`dynamicDiscount`, toggle) — the flat Y%
discount is replaced with a rate locked in at the moment of matching: 25%
more generous when a rider joins a cab that's already carrying someone (a
certain match — the generosity is justified), 50% smaller when they're
assigned to an idle cab (a bet on a future match that may never come — the
smaller discount caps the platform's exposure if it doesn't). The rate is
quoted once and never changes retroactively, same as a real upfront price.
Reuses 100% of the existing discount/margin/leakage reporting plumbing —
no new accounting needed, it all already read from final rider state.
Measured in a leakage-heavy regime (wide radius, moderate demand, 51.5%
match rate): **leaked discount fell 36% ($203 → $129), platform margin rose
22% ($383 → $469)**, with match rate itself completely unchanged — it only
ever touches price, never who gets matched. In a dense, high-match-rate
city the same mechanism is honestly more *generous* overall (most riders
get the matched-rate boost), which is the correct, non-cherry-picked result
of the same rule — reported as such in the insight card, not hidden.

All three default to **off**, verified byte-for-byte identical to the
26-test baseline when untouched, and are now covered by 32 tests total —
including that batched matching never gives a cab more than one new
commitment per tick, that no rider ever walks past `walkRadius`, and that
dynamic discounting never produces a negative fare.

## 8. Running it for judges

1. `node test/sim.test.js` — all 32 tests green.
2. Load the app with defaults — looks identical, numbers match the README.
3. Turn on **City-center demand** (~70% concentration) and **Predictive
   repositioning**, plus **Adaptive ping radius** and **Fair-detour rebate**
   (~20%). Drop the cab count to create a shortage (e.g. 18). Hit Start.
4. Watch the map: a warm glow builds downtown as requests land there, and
   idle cabs (dashed lines) visibly drift toward it instead of sitting at
   their random start points.
5. **Click anywhere on either map** to declare an incident. Watch the
   pulsing red zone appear identically on both cities, cabs already inside
   it flee outward, and routes bend around it everywhere else.
6. Open the report: riders delivered up, give-ups down, the host/joiner
   ratio gap in insight #3 narrows, "Fairness rebates paid" and "Idle cabs
   repositioned" show the honest mechanics, not hidden ones.
7. Reset. Turn on **Global batch matching**, **Shared meeting points**
   (~2–3 blocks), and **Dynamic discounting**. Run the same seed with and
   without each one to reproduce the measured deltas above: more riders
   delivered, a lower average pool detour %, and (on a sparser city) less
   leaked discount with higher margin. Insight #1's card now names and links
   straight to the fix it used to only describe.
8. For the scale story: bump cabs/riders by 5–10× in the sidebar (cheap
   thanks to #1) and show it holds — the same UI that ran 30 cabs now runs
   hundreds.
