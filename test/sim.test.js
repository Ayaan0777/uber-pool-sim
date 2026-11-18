// Engine invariants. Run: node test/sim.test.js
'use strict';
const assert = require('assert');
const S = require('../js/sim.js');
const M = require('../js/metrics.js');

const EPS = 1e-6;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}
function sim(over) {
  return new S.Simulation(Object.assign({}, S.DEFAULTS, over));
}
function runChecked(over, onStep) {
  const s = sim(over);
  while (!s.done) {
    s.step();
    if (onStep) onStep(s);
  }
  return s.finish();
}
const inCar = (r) => r.dropoffAt - r.pickupAt;

const SCENARIOS = [
  {},
  { cabs: 10 },
  { cabs: 80 },
  { riders: 600, cabs: 40, seed: 3 },
  { maxDetour: 1.2, seed: 11 },
  { maxDetour: 2.5, poolOptIn: 100, seed: 5, pingRadius: 6 },
  { gridSize: 20, riders: 300, cabs: 15, cabSpeed: 2.5, seed: 9 },
  { pingRadius: 3, patience: 40, pickupSlip: 0 },
  { pingRadius: 200, reassign: 0, riders: 400 },
  { riders: 900, cabs: 120, seed: 17 }, // exercises the spatial-index dispatch path at scale
  { meetingPoints: 1, walkRadius: 3, riders: 400, cabs: 30, seed: 18 },
  { batchMatching: 1, riders: 500, cabs: 35, seed: 19 },
  { dynamicDiscount: 1, riders: 400, cabs: 30, seed: 20 },
  { meetingPoints: 1, batchMatching: 1, dynamicDiscount: 1, riders: 500, cabs: 30, seed: 21 },
];
const cache = new Map();
function finished(over) {
  const key = JSON.stringify(over);
  if (!cache.has(key)) cache.set(key, runChecked(over));
  return cache.get(key);
}

console.log('PoolSim engine tests');

test('never more than 2 aboard, now or anywhere in a planned route', () => {
  for (const over of SCENARIOS) {
    runChecked(over, (s) => {
      for (const w of [s.pool, s.base]) {
        for (const c of w.cabs) {
          assert(c.onboard.length <= 2, 'aboard > 2');
          let load = c.onboard.length;
          for (const st of c.plan) {
            load += st.type === 'pickup' ? 1 : -1;
            assert(load <= 2 && load >= 0, `cab ${c.id} plan load ${load}`);
          }
          assert(c.plan.length <= S.MAX_PLAN_STOPS, 'plan too long');
        }
      }
    });
  }
});

test('every pool rider rides at most maxDetour x their solo estimate', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.pool.riders) {
      if (r.state !== 'done') continue;
      assert(inCar(r) <= s.cfg.maxDetour * r.est + EPS,
        `rider ${r.id}: ${inCar(r).toFixed(3)}s > ${s.cfg.maxDetour} x ${r.est.toFixed(3)}s`);
    }
  }
});

test('solo riders (both worlds) ride exactly their estimate and never share', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.base.riders.concat(s.pool.riders.filter((x) => !x.pool))) {
      if (r.state !== 'done') continue;
      assert(Math.abs(inCar(r) - r.est) < EPS, `rider ${r.id} solo ride ${inCar(r)} != ${r.est}`);
      assert(r.sharedSec < EPS && r.coRiders.length === 0, `solo rider ${r.id} shared`);
    }
    for (const c of s.base.cabs) assert(c.time.two < EPS, 'baseline cab carried 2');
  }
});

test('pickups honour the ping radius and the allowed slip', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const cfg = s.cfg;
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.pickupAt == null) continue;
        assert(r.pickupAt <= r.latestPickupAt + EPS, `rider ${r.id} picked up after the slip window`);
        assert(r.pickupAt - r.assignedAt <= cfg.pingRadius / cfg.cabSpeed + cfg.pickupSlip + EPS,
          `rider ${r.id} picked up from beyond the ping radius`);
        assert(r.pickupAt >= r.requestAt - EPS, `rider ${r.id} picked before request`);
        if (r.dropoffAt != null) assert(r.dropoffAt >= r.pickupAt, `rider ${r.id} dropped before pickup`);
      }
    }
  }
});

test('only unmatched riders give up, and only after their patience runs out', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.state !== 'lost') continue;
        assert(r.pickupAt == null && r.assignedAt == null, `rider ${r.id} lost after being matched`);
        assert(r.lostAt - r.requestAt >= s.cfg.patience - EPS, `rider ${r.id} gave up early`);
      }
    }
  }
  const tight = finished({ pingRadius: 3, patience: 40, pickupSlip: 0 });
  assert(tight.base.totals.lost > 0, 'a tight radius should strand some riders');
});

test('every cab-second is idle, empty, 1 aboard or 2 aboard', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const c of w.cabs) {
        const t = c.time.idle + c.time.empty + c.time.one + c.time.two;
        assert(Math.abs(t - w.t) < 1e-6, `cab ${c.id} time ${t} != ${w.t}`);
      }
    }
  }
});

test('driver pay = rate x (occupied s + X x 2-aboard s), and sums across cabs', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const X = s.cfg.driverPremium / 100;
    for (const w of [s.pool, s.base]) {
      let total = 0;
      for (const c of w.cabs) {
        const expect = s.cfg.driverRate * (c.time.one + c.time.two + X * c.time.two);
        assert(Math.abs(c.earnings - expect) < 1e-6, `cab ${c.id} pay mismatch`);
        total += c.earnings;
      }
      assert(Math.abs(total - w.totals.driverPay) < 1e-6, 'fleet pay mismatch');
    }
  }
});

test('pool riders pay (1 - Y) x standard fare, everyone else full fare', () => {
  const s = runChecked({ poolDiscount: 40 });
  for (const w of [s.pool, s.base]) {
    for (const r of w.riders) {
      if (r.pickupAt == null) continue;
      const expect = r.fullFare * (r.pool ? 0.6 : 1);
      assert(Math.abs(r.fare - expect) < 1e-9, `rider ${r.id} fare`);
    }
  }
});

test('cabs reroute mid-ride and riders can share with more than one co-rider', () => {
  const s = finished({ riders: 600, cabs: 40, seed: 3 });
  assert(s.pool.totals.reroutes > 0, 'no mid-ride reroutes');
  const multi = s.pool.riders.filter((r) => r.coRiders.length >= 2);
  assert(multi.length > 0, 'no rider had two co-riders');
  // ...but never two at the same time: each co-rider pair overlapped one at a time.
  for (const r of multi) {
    const spans = r.coRiders.map((id) => s.pool.riders[id])
      .map((o) => [Math.max(o.pickupAt, r.pickupAt), Math.min(o.dropoffAt ?? Infinity, r.dropoffAt ?? Infinity)])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert(spans[i][0] >= spans[i - 1][1] - EPS, `rider ${r.id} had 2 co-riders at once`);
  }
});

test('re-dispatch only runs when enabled', () => {
  assert.strictEqual(finished({ pingRadius: 200, reassign: 0, riders: 400 }).pool.totals.reassigned, 0);
  // Needs free cabs to move riders to, so use default demand with no radius cap.
  assert(runChecked({ pingRadius: 200 }).base.totals.reassigned > 0, 'expected some re-dispatches');
});

test('with 0% opt-in the pool world is identical to the baseline', () => {
  const s = runChecked({ poolOptIn: 0, riders: 300 });
  assert.strictEqual(s.pool.totals.completed, s.base.totals.completed);
  assert(Math.abs(s.pool.totals.driverPay - s.base.totals.driverPay) < 1e-9);
  s.pool.riders.forEach((r, i) => assert.strictEqual(r.dropoffAt, s.base.riders[i].dropoffAt));
});

test('same seed reproduces the run exactly; another seed differs', () => {
  const a = sim({}).runToEnd(), b = sim({}).runToEnd(), c = sim({ seed: 8 }).runToEnd();
  assert.strictEqual(a.pool.totals.driverPay, b.pool.totals.driverPay);
  assert.strictEqual(a.pool.totals.completed, b.pool.totals.completed);
  assert.notStrictEqual(a.pool.totals.driverPay, c.pool.totals.driverPay);
});

test('changing the opt-in % does not move riders or cabs', () => {
  const a = S.makeScenario(S.normalizeConfig({ poolOptIn: 20 }));
  const b = S.makeScenario(S.normalizeConfig({ poolOptIn: 90 }));
  a.riders.forEach((r, i) => {
    const q = b.riders[i];
    assert(r.ox === q.ox && r.oy === q.oy && r.dx === q.dx && r.dy === q.dy && r.requestAt === q.requestAt);
  });
});

test('driver-earnings decomposition adds up to the pool-world total', () => {
  for (const over of SCENARIOS) {
    const d = M.summarize(finished(over)).drivers.steps;
    const total = d.base + d.lostToSharing + d.detourPay + d.premium + d.fleet;
    assert(Math.abs(total - d.pool) < 1e-6, 'waterfall does not close');
  }
});

test('radius sweep: points cover the current radius and recommend one of them', () => {
  const cfg = S.normalizeConfig(S.DEFAULTS);
  const radii = M.sweepRadii(cfg);
  assert(radii.includes(cfg.pingRadius));
  const pts = radii.map((R) => M.sweepPoint(cfg, R, 1));
  assert(radii.includes(M.recommendRadius(pts, 'pool')));
  assert(pts[0].pool.lost > pts[pts.length - 1].pool.lost, 'tightest radius should lose more riders');
});

test('metrics survive degenerate runs (no riders, one cab)', () => {
  const s = M.summarize(sim({ riders: 0, cabs: 1 }).runToEnd());
  assert.strictEqual(s.pool.completed, 0);
  assert.strictEqual(s.passengers.matchRate, null);
});

test('new features default off and do not change existing behaviour', () => {
  const cfg = S.normalizeConfig(S.DEFAULTS);
  assert.strictEqual(cfg.adaptiveRadius, 0);
  assert.strictEqual(cfg.fairnessRebate, 0);
  assert.strictEqual(cfg.reposition, 0);
  const s = finished({});
  assert.strictEqual(s.pool.totals.fairnessRebate, 0, 'no rebate paid when the feature is off');
  assert.strictEqual(s.pool.totals.repositions, 0, 'no cab repositions when the feature is off');
  assert.strictEqual(s.pool.effRadius, s.cfg.pingRadius, 'effective radius is the fixed radius when adaptive is off');
});

test('fairness rebate only credits hosts, never exceeds their fare, and respects the detour cap', () => {
  const s = finished({ fairnessRebate: 100, riders: 500, cabs: 50, seed: 4 });
  let rebated = 0;
  for (const r of s.pool.riders) {
    if (r.state !== 'done') continue;
    assert(r.fare > -1e-9, `rider ${r.id} fare went negative`);
    assert(inCar(r) <= s.cfg.maxDetour * r.est + EPS, 'rebate must not loosen the detour cap');
    if (!r.pool) continue;
    const expectFull = r.fullFare * (1 - s.cfg.poolDiscount / 100);
    if (r.hosted && !r.joinedOccupied && inCar(r) > r.est + EPS) {
      assert(r.fare <= expectFull + EPS, `host ${r.id} fare should be reduced by the rebate`);
      rebated++;
    } else {
      assert(Math.abs(r.fare - expectFull) < 1e-6, `non-host rider ${r.id} fare should be untouched by the rebate`);
    }
  }
  assert(rebated > 0, 'expected at least one rebated host in a 500-rider run');
  assert(s.pool.totals.fairnessRebate > 0);
});

test('fairness rebate is self-accounted: revenue + discount + rebate stays internally consistent', () => {
  const s = finished({ fairnessRebate: 50, riders: 400, cabs: 40, seed: 6 });
  const t = s.pool.totals;
  let grossFullFare = 0;
  for (const r of s.pool.riders) if (r.pickupAt != null) grossFullFare += r.fullFare;
  assert(Math.abs((t.revenue + t.discount) - grossFullFare) < 1e-6, 'revenue + discount should equal gross fare charged');
});

test('idle repositioning moves idle cabs toward queued demand, and never touches a cab with real stops', () => {
  const s = finished({ reposition: 1, repositionIdleTime: 10, riders: 150, cabs: 10, pingRadius: 6, seed: 2 });
  assert(s.pool.totals.repositions > 0, 'expected some repositioning in a shortage scenario');
  // Reposition is driven outside cab.plan, so it can never desync from the
  // pickup/dropoff machinery: a cab with a real plan or a rider never reports one.
  for (const c of s.pool.cabs) {
    if (c.plan.length || c.riders.length) assert.strictEqual(c.reposition, null, `cab ${c.id} should not have a reposition target while committed`);
  }
});

test('adaptive radius stays within bounds and reacts to supply/demand', () => {
  const shortage = finished({ adaptiveRadius: 1, cabs: 6, riders: 500, pingRadius: 15, seed: 8 });
  assert(shortage.pool.effRadius >= 2 - EPS && shortage.pool.effRadius <= shortage.cfg.pingRadius * 1.6 + EPS,
    'effective radius must stay within its configured bounds');
  const surplus = finished({ adaptiveRadius: 1, cabs: 150, riders: 100, pingRadius: 15, seed: 8 });
  assert(surplus.pool.effRadius <= shortage.pool.effRadius + EPS,
    'a cab surplus should not need a wider radius than a shortage of the same city');
});

test('city-center demand clusters request origins near the grid center; off is unchanged uniform', () => {
  const G = 50, cx = (G - 1) / 2, cy = (G - 1) / 2;
  function avgDistFromCenter(cfg) {
    const sc = S.makeScenario(S.normalizeConfig(cfg));
    let sum = 0;
    for (const r of sc.riders) sum += Math.abs(r.ox - cx) + Math.abs(r.oy - cy);
    return sum / sc.riders.length;
  }
  const uniform = avgDistFromCenter({ gridSize: G, riders: 2000, seed: 1 });
  const hotspot = avgDistFromCenter({ gridSize: G, riders: 2000, seed: 1, cityCenterDemand: 1, demandConcentration: 70 });
  assert(hotspot < uniform * 0.6, `hotspot origins should cluster much closer to center (${hotspot.toFixed(1)} vs uniform ${uniform.toFixed(1)})`);

  // Opt-in independence must still hold: turning Pool on/off is orthogonal to demand shape.
  const a = S.makeScenario(S.normalizeConfig({ cityCenterDemand: 1, poolOptIn: 10 }));
  const b = S.makeScenario(S.normalizeConfig({ cityCenterDemand: 1, poolOptIn: 90 }));
  a.riders.forEach((r, i) => assert(r.ox === b.riders[i].ox && r.oy === b.riders[i].oy));
});

test('predictive repositioning pulls idle cabs toward observed demand concentration', () => {
  const G = 50, cx = (G - 1) / 2, cy = (G - 1) / 2, over = {
    riders: 500, cabs: 18, duration: 400, gridSize: G,
    cityCenterDemand: 1, demandConcentration: 70, pingRadius: 10, seed: 3,
  };
  const off = finished(Object.assign({}, over, { reposition: 0 }));
  const on = finished(Object.assign({}, over, { reposition: 1, repositionIdleTime: 15 }));
  function avgCabDistFromCenter(w) {
    let sum = 0;
    for (const c of w.cabs) sum += Math.abs(c.x - cx) + Math.abs(c.y - cy);
    return sum / w.cabs.length;
  }
  assert(on.pool.totals.repositions > 0, 'expected repositioning to trigger under a downtown shortage');
  assert(avgCabDistFromCenter(on.pool) < avgCabDistFromCenter(off.pool),
    'cabs should end up closer to the demand center when predictive repositioning is on');
  assert(on.pool.totals.completed >= off.pool.totals.completed,
    'predictive repositioning should not deliver fewer riders than sitting still');
});

test('grid-indexed dispatch still only matches cabs within the ping radius, at scale', () => {
  const s = finished({ riders: 900, cabs: 120, seed: 17 });
  for (const w of [s.pool, s.base]) {
    for (const r of w.riders) {
      if (r.pickupAt == null) continue;
      assert(r.pickupAt - r.assignedAt <= s.cfg.pingRadius / s.cfg.cabSpeed + s.cfg.pickupSlip + EPS,
        `rider ${r.id} matched from beyond the ping radius under the spatial index`);
    }
  }
});

test('a declared incident: no stop is ever planned inside it, in either twin city, even overlapping', () => {
  const s = sim({ riders: 400, cabs: 30, duration: 300, seed: 12, gridSize: 50, threatRadius: 9, threatDuration: 200 });
  while (s.t < 50) s.step();
  s.declareThreat(20, 25);
  while (s.t < 70) s.step();
  s.declareThreat(30, 25); // overlaps the first
  while (s.t < 90) s.step();
  s.declareThreat(25, 15); // a third, nearby
  let stopViolations = 0;
  while (!s.done) {
    s.step();
    for (const w of [s.pool, s.base]) {
      const active = w.activeThreats();
      if (!active) continue;
      for (const c of w.cabs) for (const st of c.plan) {
        if (w.inThreat(st.x, st.y, active)) stopViolations++;
      }
    }
  }
  assert.strictEqual(stopViolations, 0, 'no pickup/dropoff should ever be planned inside an active incident zone');
  assert(s.pool.totals.threatsDeclared === 3 && s.base.totals.threatsDeclared === 3);
});

test('both twin cities see an identical declared incident, at the same instant', () => {
  const s = sim({ riders: 200, cabs: 20, seed: 4 });
  while (s.t < 40) s.step();
  const declared = s.declareThreat(12.4, 37.9); // non-integer input gets rounded identically
  assert.deepStrictEqual(s.pool.threats[s.pool.threats.length - 1], s.base.threats[s.base.threats.length - 1]);
  assert.strictEqual(declared.x, Math.round(12.4));
  assert.strictEqual(declared.y, Math.round(37.9));
});

test('a cab caught inside a new zone flees monotonically and never re-enters while it is active', () => {
  const s = sim({ riders: 300, cabs: 25, duration: 300, seed: 5, threatRadius: 10, threatDuration: 60 });
  while (s.t < 100) s.step();
  const G = s.cfg.gridSize, cx = Math.floor(G / 2), cy = Math.floor(G / 2);
  s.declareThreat(cx, cy);
  const lastDist = {}, wasInside = {}, reentries = {};
  while (!s.done) {
    s.step();
    for (const w of [s.pool, s.base]) {
      const active = w.activeThreats();
      for (const c of w.cabs) {
        const key = (w === s.pool ? 'p' : 'b') + c.id;
        const d = Math.abs(c.x - cx) + Math.abs(c.y - cy);
        const inside = !!active && w.inThreat(c.x, c.y, active);
        if (inside) {
          if (lastDist[key] !== undefined) {
            assert(d >= lastDist[key] - EPS, `cab ${key} moved closer to the incident center while inside it: ${lastDist[key]} -> ${d}`);
          }
          if (wasInside[key] === 'out') reentries[key] = (reentries[key] || 0) + 1;
          wasInside[key] = true;
        } else if (wasInside[key] === true) {
          wasInside[key] = 'out';
        }
        lastDist[key] = d;
      }
    }
  }
  s.finish();
  assert.strictEqual(Object.keys(reentries).length, 0, 'no cab should re-enter an incident zone that is still active once it has left');
});

test('a cancelled pickup returns the rider to waiting, and the threat expiring lets normal matching resume', () => {
  const s = sim({ riders: 500, cabs: 40, duration: 500, pingRadius: 20, seed: 6 });
  while (s.t < 30) s.step();
  s.declareThreat(25, 25); // default threatRadius=8, threatDuration=90
  while (s.t < 35) s.step();
  const cancelledSoFar = s.pool.totals.threatCancellations;
  if (cancelledSoFar > 0) {
    // Any rider marked threatCancelled must be back in a matchable state.
    for (const r of s.pool.riders) {
      if (r.threatCancelled > 0 && r.state === 'done') continue; // may have been matched again since
      if (r.threatCancelled > 0) assert(r.state === 'waiting' || r.state === 'assigned' || r.state === 'riding',
        `cancelled rider ${r.id} should have re-entered normal matching, got state ${r.state}`);
    }
  }
  s.runToEnd();
  // After the threat expires, the engine must return to its default fast
  // path (no active threats) and keep functioning normally.
  assert.strictEqual(s.pool.activeThreats(), null, 'threat should have expired by the end of a 500s run with a 90s duration');
});

test('threats default to none, and are a zero-cost no-op until declared', () => {
  const cfg = S.normalizeConfig(S.DEFAULTS);
  const s = finished({});
  assert.strictEqual(s.pool.totals.threatsDeclared, 0);
  assert.strictEqual(s.pool.totals.evacuations, 0);
  assert.strictEqual(s.pool.activeThreats(), null);
});

test('meeting points: pool riders never walk more than walkRadius, solo riders are never moved, off reproduces exact addresses', () => {
  const on = finished({ meetingPoints: 1, walkRadius: 3, riders: 400, cabs: 30, seed: 18 });
  for (const r of on.pool.riders) {
    if (r.pool) {
      assert(Math.abs(r.mpx - r.ox) + Math.abs(r.mpy - r.oy) <= on.cfg.walkRadius,
        `pool rider ${r.id} pickup walk exceeds walkRadius`);
      assert(Math.abs(r.mdx - r.dx) + Math.abs(r.mdy - r.dy) <= on.cfg.walkRadius,
        `pool rider ${r.id} drop-off walk exceeds walkRadius`);
    } else {
      assert.strictEqual(r.mpx, r.ox); assert.strictEqual(r.mpy, r.oy);
      assert.strictEqual(r.mdx, r.dx); assert.strictEqual(r.mdy, r.dy);
    }
  }
  const off = finished({ meetingPoints: 0, riders: 400, cabs: 30, seed: 18 });
  for (const r of off.pool.riders) {
    assert.strictEqual(r.mpx, r.ox); assert.strictEqual(r.mpy, r.oy);
    assert.strictEqual(r.mdx, r.dx); assert.strictEqual(r.mdy, r.dy);
  }
});

test('batch matching: at most one new commitment per cab per dispatch tick, and still respects every hard rule', () => {
  const over = { batchMatching: 1, riders: 500, cabs: 35, seed: 19 };
  const s = sim(over);
  while (!s.done) {
    const before = new Map(s.pool.cabs.map((c) => [c.id, c.riders.length]));
    s.step();
    // A single sequential matchQueueSequential pass can also add exactly one
    // rider per cab in one scan, but batched matching must never add *more*
    // than one in a single tick (that would mean a stale/duplicate commit).
    for (const c of s.pool.cabs) {
      const gained = c.riders.length - (before.get(c.id) ?? 0);
      assert(gained <= 1, `cab ${c.id} gained ${gained} new riders in one tick -- the one-commit-per-cab-per-tick guard should cap this at 1`);
    }
  }
  const finishedS = s.finish();
  assert(finishedS.pool.totals.completed > 0);
});

test('dynamic discount: locked at commit time, never negative, and reduces leakage in a low-match-rate city', () => {
  const s = finished({ dynamicDiscount: 1, riders: 400, cabs: 30, seed: 20 });
  for (const r of s.pool.riders) {
    if (r.state !== 'done' || !r.pool) continue;
    assert(r.fare >= -1e-9, `rider ${r.id} fare went negative under dynamic discount`);
    assert(r.dynamicY != null, `matched pool rider ${r.id} should have a locked-in dynamic rate`);
    assert(r.dynamicY <= 0.9 + 1e-9, 'dynamic rate must stay below the 90% cap');
  }
  // In a sparse, wide-radius city (lots of unmatched opt-ins), dynamic
  // discounting should cut leakage and protect margin vs. the flat rate.
  const sparse = { riders: 150, cabs: 25, duration: 300, seed: 9, pingRadius: 25, poolOptIn: 80 };
  const flat = M.summarize(finished(Object.assign({}, sparse, { dynamicDiscount: 0 })));
  const dyn = M.summarize(finished(Object.assign({}, sparse, { dynamicDiscount: 1 })));
  assert(dyn.passengers.leaked < flat.passengers.leaked, 'dynamic discount should leak less than the flat rate in a leakage-heavy city');
  assert(dyn.pool.margin > flat.pool.margin, 'dynamic discount should protect margin in a leakage-heavy city');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
