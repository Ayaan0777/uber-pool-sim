/*
 * PoolSim engine — pure simulation, no DOM.
 *
 * Two "twin" worlds are built from one scenario (same riders, same request
 * times, same cab start positions). One world allows pooling, the other
 * serves everyone solo. Comparing them isolates the effect of Pool.
 *
 * Model
 *  - City: G x G intersections, Manhattan metric. Cabs move one edge at a
 *    time and only turn at intersections, so a planned stop time is exactly
 *    the realised time (no traffic noise).
 *  - Requests arrive at random times over the whole run. A rider's "original
 *    estimate" is the solo in-car time: manhattan(origin, destination) / speed.
 *  - Each cab has a plan: an ordered list of pickups and drop-offs. A new pool
 *    request may be inserted anywhere in a pool cab's plan (the cab reroutes),
 *    so one rider can share with several co-riders over a single trip.
 *  - Hard rules checked on every insertion, for every rider in the plan:
 *      * never more than 2 riders aboard at any point of the plan;
 *      * a pool rider's in-car time <= maxDetour x their estimate;
 *      * an assigned rider's pickup slips at most pickupSlip seconds past
 *        the time they were promised;
 *      * the new rider's pickup is within pingRadius blocks of driving.
 *  - Unmatched riders give up after `patience` seconds.
 *  - Optional re-dispatch: an assigned rider still waiting for pickup is moved
 *    to a free cab that can reach them much sooner.
 *  - Driver pay: driverRate per occupied second, x(1 + X) while 2 are aboard.
 *    Driving to a pickup is unpaid. Running cost accrues per block driven.
 *  - Rider fare: fareRate x estimate, x(1 - Y) for pool opt-ins, charged at
 *    pickup whether or not a co-rider is ever found.
 */
// Wrapped in a named factory so app.js can also boot it inside a Web Worker.
function definePoolSim(root) {
  'use strict';

  var DEFAULTS = {
    gridSize: 50,       // intersections per side
    riders: 200,        // K
    cabs: 30,           // N
    duration: 300,      // P, simulated seconds
    poolOptIn: 60,      // % of riders who opt in to Pool
    maxDetour: 1.5,     // max in-car time / original estimate
    driverPremium: 25,  // X, % extra per second while 2 riders are aboard
    poolDiscount: 30,   // Y, % off the standard fare for opting in
    pingRadius: 15,     // blocks of driving from a cab to a pickup
    patience: 120,      // seconds a rider waits unmatched before giving up
    pickupSlip: 20,     // seconds a promised pickup may slip when a cab reroutes
    reassign: 1,        // 1 = move waiting riders to a cab that frees up closer
    cabSpeed: 1,        // blocks per second
    fareRate: 0.5,      // $ per second of original estimate
    driverRate: 0.35,   // $ per occupied second
    costPerBlock: 0.05, // driver's running cost, $ per block driven
    adaptiveRadius: 0,  // 1 = widen/tighten the ping radius with live supply/demand
    fairnessRebate: 0,  // % of a host's excess detour cost rebated to them at drop-off
    reposition: 0,      // 1 = idle cabs predictively drift toward likely-demand zones
    repositionIdleTime: 20, // seconds idle before a cab starts repositioning
    cityCenterDemand: 0, // 1 = requests cluster near the grid center (downtown), not uniform
    demandConcentration: 65, // % how tightly requests cluster toward the center, when on
    threatRadius: 8,     // blocks: fixed radius of a declared incident's impact zone
    threatDuration: 90,  // seconds an incident stays active before it's cleared
    meetingPoints: 0,    // 1 = pool riders walk to a shared pickup/drop-off point nearby
    walkRadius: 2,       // blocks a pool rider will walk to reach a meeting point
    batchMatching: 0,    // 1 = rank the whole dispatch batch by cost before committing,
                          // instead of committing strictly in request-arrival order
    dynamicDiscount: 0,  // 1 = the pool discount scales with match confidence at commit time
    turnPenaltySec: 0,   // seconds a left turn costs that a right turn/straight-through does not
    seed: 7,
  };

  var DT = 0.1;               // simulation step, seconds
  var DISPATCH_EVERY = 1;     // matching batch interval, seconds
  var MIN_TRIP_BLOCKS = 3;
  var MAX_PLAN_STOPS = 6;     // pending stops a cab may hold
  var VEHICLE_WEIGHT = 0.5;   // value of a cab-second relative to a rider-second
  var MAX_QUEUE_SCAN = 250;   // riders considered per dispatch batch (oldest first)
  var REASSIGN_MIN_GAIN = 8;  // seconds of pickup a re-dispatch must save...
  var REASSIGN_MIN_RATIO = 0.7; // ...and the new ETA must be <= 70% of the old
  var HEAT_N = 10;             // demand-heatmap resolution: HEAT_N x HEAT_N cells citywide
  var HEAT_DECAY = 0.985;      // per dispatch tick (~46s half-life): recent demand dominates
  var HEAT_TOPK = 3;           // idle cabs spread across the top-K hottest zones, not just one
  // Dynamic discounting: committing to an already-occupied pool cab means a
  // match is certain, so the discount can afford to be more generous there;
  // committing to an idle cab is a bet that someone else joins later, so the
  // discount is the platform's exposure to leakage if nobody ever does --
  // cut it, rather than paying it in full on a coin flip.
  var DYNAMIC_DISCOUNT_MATCHED = 1.25;
  var DYNAMIC_DISCOUNT_UNMATCHED = 0.5;
  var EPS = 1e-6;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function manhattan(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  // City layout: left turns cost extra time (modeled on UPS's ORION
  // routing, which minimizes left turns fleet-wide because they mean
  // waiting for a gap in oncoming traffic or a signal), right turns and
  // straight-throughs are free. Headings are 0=N, 1=E, 2=S, 3=W, clockwise,
  // so "turn right" is always +1 mod 4 and "turn left" is always -1 mod 4
  // regardless of which direction you started facing.
  function headingOf(dx, dy) {
    if (dx > 0) return 1;
    if (dx < 0) return 3;
    if (dy > 0) return 2;
    if (dy < 0) return 0;
    return null;
  }
  function isLeftTurn(from, to) {
    return from != null && to != null && from !== to && ((to - from + 4) % 4) === 3;
  }
  // Walk the L-route (x-leg then y-leg, the exact order advance() drives in)
  // from (x, y) to (tx, ty) given the heading on arrival at (x, y). Returns
  // the extra seconds owed for any left turns this leg requires and the
  // heading after it, so evalPlan's time estimate matches what actually
  // happens to the cab, turn for turn -- not just the Manhattan distance.
  function legTurnPenalty(x, y, tx, ty, heading, penaltySec) {
    var extra = 0, left = 0, right = 0, h;
    if (tx !== x) {
      h = headingOf(Math.sign(tx - x), 0);
      if (h !== heading) { if (isLeftTurn(heading, h)) { extra += penaltySec; left++; } else if (heading != null) right++; }
      heading = h;
    }
    if (ty !== y) {
      h = headingOf(0, Math.sign(ty - y));
      if (h !== heading) { if (isLeftTurn(heading, h)) { extra += penaltySec; left++; } else if (heading != null) right++; }
      heading = h;
    }
    return { extra: extra, heading: heading, left: left, right: right };
  }

  // Meeting points: snap to the nearest intersection on a coarse lattice of
  // spacing `step`. Nearby requests snap to the same point, which is the
  // whole mechanism -- two stops at identical coordinates cost a cab zero
  // extra travel between them, so bestInsertion naturally favors clustering
  // without any change to the matching algorithm itself.
  function snapToMeetingPoint(x, y, G, step) {
    return {
      x: Math.max(0, Math.min(G - 1, Math.round(x / step) * step)),
      y: Math.max(0, Math.min(G - 1, Math.round(y / step) * step)),
    };
  }

  // Does the axis-aligned segment from (lo..hi) along `fixed` (a row if
  // isRow, else a column) pass through the Manhattan-diamond hazard `th`?
  // Exact, not a bounding-box approximation: for a fixed row/column, the
  // diamond |dx|+|dy| <= r intersects it along a contiguous interval of the
  // other axis, which this just intersects against [lo, hi].
  function segHitsThreat(lo, hi, fixed, th, isRow) {
    var m = isRow ? th.radius - Math.abs(fixed - th.y) : th.radius - Math.abs(fixed - th.x);
    if (m < 0) return false;
    var center = isRow ? th.x : th.y;
    return !(hi < center - m || lo > center + m);
  }

  function normalizeConfig(input) {
    var cfg = {};
    for (var k in DEFAULTS) {
      var v = input && input[k] != null ? Number(input[k]) : DEFAULTS[k];
      cfg[k] = isFinite(v) ? v : DEFAULTS[k];
    }
    cfg.gridSize = Math.max(10, Math.round(cfg.gridSize));
    cfg.riders = Math.max(0, Math.round(cfg.riders));
    cfg.cabs = Math.max(1, Math.round(cfg.cabs));
    cfg.duration = Math.max(1, cfg.duration);
    cfg.maxDetour = Math.max(1, cfg.maxDetour);
    cfg.pingRadius = Math.max(1, cfg.pingRadius);
    cfg.patience = Math.max(1, cfg.patience);
    cfg.pickupSlip = Math.max(0, cfg.pickupSlip);
    cfg.reassign = cfg.reassign ? 1 : 0;
    cfg.cabSpeed = Math.max(0.1, cfg.cabSpeed);
    cfg.adaptiveRadius = cfg.adaptiveRadius ? 1 : 0;
    cfg.fairnessRebate = Math.min(100, Math.max(0, cfg.fairnessRebate));
    cfg.reposition = cfg.reposition ? 1 : 0;
    cfg.repositionIdleTime = Math.max(1, cfg.repositionIdleTime);
    cfg.cityCenterDemand = cfg.cityCenterDemand ? 1 : 0;
    cfg.demandConcentration = Math.min(95, Math.max(5, cfg.demandConcentration));
    cfg.threatRadius = Math.max(1, cfg.threatRadius);
    cfg.threatDuration = Math.max(1, cfg.threatDuration);
    cfg.meetingPoints = cfg.meetingPoints ? 1 : 0;
    cfg.walkRadius = Math.max(1, cfg.walkRadius);
    cfg.batchMatching = cfg.batchMatching ? 1 : 0;
    cfg.dynamicDiscount = cfg.dynamicDiscount ? 1 : 0;
    cfg.turnPenaltySec = Math.max(0, cfg.turnPenaltySec);
    cfg.seed = Math.round(cfg.seed) >>> 0;
    return cfg;
  }

  // Demand: uniform random by default. With cityCenterDemand on, request
  // origins instead cluster toward the grid center (downtown), via inverse-
  // transform sampling on the radius: r = maxR x rng()^power, power > 1 pulls
  // mass inward. Destinations stay uniform (riders still scatter outward to
  // wherever they live) -- only pickup density is skewed.
  function makeScenario(cfg) {
    var rng = mulberry32(cfg.seed);
    var G = cfg.gridSize;
    function node() {
      return { x: Math.floor(rng() * G), y: Math.floor(rng() * G) };
    }
    var cx = (G - 1) / 2, cy = (G - 1) / 2, maxR = Math.SQRT2 * (G - 1) / 2;
    var power = 1 + (cfg.demandConcentration / 100) * 5;
    function hotspotNode() {
      var r = maxR * Math.pow(rng(), power);
      var theta = rng() * Math.PI * 2;
      return {
        x: Math.max(0, Math.min(G - 1, Math.round(cx + r * Math.cos(theta)))),
        y: Math.max(0, Math.min(G - 1, Math.round(cy + r * Math.sin(theta)))),
      };
    }
    var origin = cfg.cityCenterDemand ? hotspotNode : node;
    var cabs = [];
    for (var i = 0; i < cfg.cabs; i++) cabs.push(node());
    var riders = [];
    for (var j = 0; j < cfg.riders; j++) {
      var requestAt = rng() * cfg.duration;
      var o = origin();
      var d = node();
      while (manhattan(o.x, o.y, d.x, d.y) < MIN_TRIP_BLOCKS) d = node();
      // Drawn for every rider so changing the opt-in % never moves anyone.
      var optIn = rng() * 100 < cfg.poolOptIn;
      riders.push({ requestAt: requestAt, ox: o.x, oy: o.y, dx: d.x, dy: d.y, optIn: optIn });
    }
    riders.sort(function (a, b) { return a.requestAt - b.requestAt; });
    riders.forEach(function (r, idx) { r.id = idx; });
    return { cabs: cabs, riders: riders };
  }

  function World(cfg, scenario, poolEnabled) {
    this.cfg = cfg;
    this.poolEnabled = poolEnabled;
    this.speed = cfg.cabSpeed;
    this.X = cfg.driverPremium / 100;
    this.Y = cfg.poolDiscount / 100;
    this.steps = 0;
    this.t = 0;
    this.nextDispatchAt = 0;
    this.arrivalIdx = 0;
    this.queue = [];
    this.series = [];
    this.lostLog = [];
    this.totals = {
      revenue: 0, driverPay: 0, premium: 0, discount: 0,
      requested: 0, pickedUp: 0, completed: 0, lost: 0, waitSum: 0,
      reroutes: 0, reassigned: 0, fairnessRebate: 0, repositions: 0,
      threatsDeclared: 0, threatCancellations: 0, evacuations: 0,
      leftTurns: 0, rightTurns: 0, turnDelaySec: 0,
    };
    this.threats = []; // declared incidents: { x, y, radius, at, duration }
    this.effRadius = cfg.pingRadius; // live effective ping radius (adaptiveRadius)
    this.gridCell = Math.max(2, cfg.pingRadius);
    this.grid = null;

    // Predictive repositioning's demand heatmap: a coarse grid of decayed
    // observed-arrival counts, built online from nothing but past requests
    // (never the future) -- only allocated when the feature is on.
    this.heatCells = Math.max(2, Math.min(HEAT_N, cfg.gridSize));
    this.heatStep = cfg.gridSize / this.heatCells;
    this.heat = cfg.reposition ? new Array(this.heatCells * this.heatCells) : null;
    if (this.heat) for (var hz = 0; hz < this.heat.length; hz++) this.heat[hz] = 0;

    var speed = this.speed;
    this.cabs = scenario.cabs.map(function (p, i) {
      return {
        id: i, x: p.x, y: p.y, next: null, progress: 0,
        plan: [],       // pending stops, in order
        riders: [],     // riders committed: assigned or aboard
        onboard: [],
        time: { idle: 0, empty: 0, one: 0, two: 0 },
        blocks: { empty: 0, one: 0, two: 0 },
        earnings: 0, premium: 0, trips: 0, reroutes: 0,
        planVersion: 0, rerouteVersion: 0,
        _base: null, _baseKey: '',
        idleSince: 0, reposition: null,
        heading: null, turnDelay: 0, leftTurns: 0, rightTurns: 0, avoidTarget: null,
      };
    });
    this.riders = scenario.riders.map(function (r) {
      var direct = manhattan(r.ox, r.oy, r.dx, r.dy);
      var pool = poolEnabled && r.optIn;
      // Meeting points: a pool rider's pickup/drop-off may be a shared point
      // a short walk from their real address, not the address itself -- so
      // nearby pool requests can share one stop instead of each costing the
      // cab a separate detour. The fare/estimate stay based on the real
      // door-to-door distance (the promise doesn't change); only the
      // physical stop the cab actually drives to moves.
      var mp = null, md = null, walkBlocks = 0;
      if (cfg.meetingPoints && pool) {
        mp = snapToMeetingPoint(r.ox, r.oy, cfg.gridSize, cfg.walkRadius);
        md = snapToMeetingPoint(r.dx, r.dy, cfg.gridSize, cfg.walkRadius);
        walkBlocks = manhattan(r.ox, r.oy, mp.x, mp.y) + manhattan(r.dx, r.dy, md.x, md.y);
      }
      return {
        id: r.id, requestAt: r.requestAt, ox: r.ox, oy: r.oy, dx: r.dx, dy: r.dy,
        optIn: r.optIn,
        pool: pool,
        mpx: mp ? mp.x : r.ox, mpy: mp ? mp.y : r.oy, // actual pickup stop the cab drives to
        mdx: md ? md.x : r.dx, mdy: md ? md.y : r.dy, // actual drop-off stop the cab drives to
        walkBlocks: walkBlocks,
        direct: direct,
        est: direct / speed,
        fullFare: direct / speed * cfg.fareRate,
        fare: 0,
        state: 'scheduled',     // scheduled -> waiting -> assigned -> riding -> done | lost
        cab: null,
        assignedAt: null, promisedPickupAt: null, latestPickupAt: null,
        pickupAt: null, dropoffAt: null, lostAt: null,
        sharedSec: 0,
        coRiders: [],           // ids of everyone this rider shared the cab with
        reroutes: 0,            // times their cab changed course while they were aboard
        reassigned: 0,          // times moved to a closer cab before pickup
        joinedOccupied: false,  // boarded a cab that already had a rider
        hosted: false,          // someone boarded while this rider was aboard
        evacuated: false,       // drop-off was relocated to a safe point because of an incident
        evacuatedTo: null,
        threatCancelled: 0,     // times a declared incident cancelled this rider's pending pickup
        dynamicY: null,         // discount rate locked in at commit time, when dynamicDiscount is on
      };
    });
  }

  World.prototype.step = function () {
    // Riders who requested before this instant join the queue.
    while (this.arrivalIdx < this.riders.length && this.riders[this.arrivalIdx].requestAt <= this.t) {
      var r = this.riders[this.arrivalIdx++];
      r.state = 'waiting';
      this.queue.push(r);
      this.totals.requested++;
      if (this.heat) this.heat[this.heatIndex(r.ox, r.oy)]++;
    }
    if (this.t >= this.nextDispatchAt - EPS) {
      this.dispatch();
      this.sample();
      this.nextDispatchAt += DISPATCH_EVERY;
    }
    for (var i = 0; i < this.cabs.length; i++) this.advance(this.cabs[i]);
    this.steps++;
    this.t = this.steps * DT;
  };

  // ---------------------------------------------------------------- movement

  World.prototype.advance = function (cab) {
    var budget = this.speed * DT; // blocks this step
    var now = this.t;
    for (var guard = 0; guard < 10000; guard++) {
      // Paying off a left-turn wait: the cab is stopped at the corner, not
      // moving, but the clock (and the meter, if it's carrying someone)
      // keeps running -- the same accrue() every other second uses, just
      // with zero blocks covered.
      if (cab.turnDelay > EPS) {
        var waitBlocks = Math.min(cab.turnDelay * this.speed, budget);
        var waitSec = waitBlocks / this.speed;
        this.accrue(cab, waitSec, 0);
        cab.turnDelay -= waitSec;
        budget -= waitBlocks;
        now += waitSec;
        if (budget <= EPS) return;
        continue;
      }
      if (!cab.next) {
        this.serveStops(cab, now);
        var threats = this.threats.length ? this.activeThreats() : null;
        // Standing inside a live zone overrides everything else -- including
        // being otherwise fully idle with no plan and no reposition target.
        // A cab can end up here either because a new incident was just
        // declared on top of it, or because it's parked between stops when
        // one appears; either way, fleeing is not optional.
        var fleeing = threats && this.inThreat(cab.x, cab.y, threats);
        // Fleeing re-aims at the nearest safe point fresh every intersection
        // -- it has to: heading toward a *fixed* corner can briefly pass
        // closer to the center first if that corner isn't on the cab's
        // current axis, so only continuous re-aiming guarantees the strictly
        // outward egress the rest of the engine (and its tests) rely on.
        // Real stops always win over a reposition drift (an idle-cab
        // placeholder, never part of cab.plan); fleeing beats both.
        var s = fleeing ? this.nearestSafePoint(cab.x, cab.y, threats)
          : (cab.plan.length ? cab.plan[0] : cab.reposition);
        if (!s || (s.x === cab.x && s.y === cab.y)) {
          cab.time.idle += budget / this.speed;
          return;
        }
        if (budget <= EPS) return;
        // Routing *around* a zone toward some other destination, by
        // contrast, is sticky -- the chosen waypoint is held until the cab
        // actually reaches it or the direct path clears, rather than
        // re-picked fresh at every intersection. Re-picking the "cheapest
        // corner" every step can flip-flop as the cab's position shifts,
        // which costs only a few extra blocks normally but compounds badly
        // once turns carry a time penalty; fleeing never has this problem
        // since it has no destination beyond "away" to flip-flop around.
        var dest = s;
        if (threats && !fleeing) {
          if (!this.legCrossesThreats(cab.x, cab.y, s.x, s.y, threats)) {
            cab.avoidTarget = null;
          } else if (!cab.avoidTarget || (cab.x === cab.avoidTarget.x && cab.y === cab.avoidTarget.y)) {
            cab.avoidTarget = this.safeStepTarget(cab, s, threats);
          }
          if (cab.avoidTarget) dest = cab.avoidTarget;
        } else if (!threats) {
          cab.avoidTarget = null;
        }
        // L-shaped routing: finish the x leg, then the y leg -- except while
        // fleeing with both legs still pending, where the safe point shares
        // one axis with the threat's own center (that's how the corner was
        // picked), so moving that shared axis first wouldn't retreat at all;
        // the axis that actually increases distance from the threat goes
        // first instead, so distance from it never dips mid-escape.
        var xFirst = dest.x !== cab.x;
        if (fleeing && dest.x !== cab.x && dest.y !== cab.y) {
          for (var ti = 0; ti < threats.length; ti++) {
            var th = threats[ti];
            if (manhattan(cab.x, cab.y, th.x, th.y) > th.radius) continue;
            var xAway = cab.x === th.x || Math.sign(cab.x - th.x) === Math.sign(dest.x - cab.x);
            var yAway = cab.y === th.y || Math.sign(cab.y - th.y) === Math.sign(dest.y - cab.y);
            if (yAway && !xAway) xFirst = false;
            break;
          }
        }
        var newHeading = xFirst ? headingOf(Math.sign(dest.x - cab.x), 0) : headingOf(0, Math.sign(dest.y - cab.y));
        cab.next = xFirst
          ? { x: cab.x + Math.sign(dest.x - cab.x), y: cab.y }
          : { x: cab.x, y: cab.y + Math.sign(dest.y - cab.y) };
        cab.progress = 0;
        // Right turns and straight-throughs are free; a left turn means
        // waiting for a gap in oncoming traffic, so it costs turnPenaltySec.
        if (newHeading !== cab.heading) {
          if (isLeftTurn(cab.heading, newHeading)) {
            cab.leftTurns++;
            this.totals.leftTurns++;
            if (this.cfg.turnPenaltySec > 0) {
              cab.turnDelay += this.cfg.turnPenaltySec;
              this.totals.turnDelaySec += this.cfg.turnPenaltySec;
            }
          } else if (cab.heading != null) {
            cab.rightTurns++;
            this.totals.rightTurns++;
          }
          cab.heading = newHeading;
          // A left turn was just charged: pay it off before covering any
          // distance this tick, rather than sneaking in a sliver of the new
          // edge first -- the loop top drains turnDelay before anything else.
          if (cab.turnDelay > EPS) continue;
        }
      }
      var move = Math.min(1 - cab.progress, budget);
      var sec = move / this.speed;
      this.accrue(cab, sec, move);
      cab.progress += move;
      budget -= move;
      now += sec;
      if (cab.progress >= 1 - EPS) {
        cab.x = cab.next.x;
        cab.y = cab.next.y;
        cab.next = null;
        cab.progress = 0;
        if (!cab.plan.length && cab.reposition && cab.x === cab.reposition.x && cab.y === cab.reposition.y) {
          cab.reposition = null;
          cab.idleSince = now;
        }
      }
      if (budget <= EPS) {
        if (!cab.next) this.serveStops(cab, now);
        return;
      }
    }
  };

  World.prototype.accrue = function (cab, sec, blocks) {
    var n = cab.onboard.length;
    if (n === 0) {
      cab.time.empty += sec;
      cab.blocks.empty += blocks;
      return;
    }
    var rate = this.cfg.driverRate;
    var pay = rate * sec;
    if (n === 1) {
      cab.time.one += sec;
      cab.blocks.one += blocks;
    } else {
      var prem = rate * this.X * sec;
      pay += prem;
      cab.premium += prem;
      cab.time.two += sec;
      cab.blocks.two += blocks;
      this.totals.premium += prem;
      cab.onboard[0].sharedSec += sec;
      cab.onboard[1].sharedSec += sec;
    }
    cab.earnings += pay;
    this.totals.driverPay += pay;
  };

  World.prototype.serveStops = function (cab, now) {
    while (cab.plan.length && cab.plan[0].x === cab.x && cab.plan[0].y === cab.y) {
      var stop = cab.plan.shift();
      var r = stop.rider;
      cab.planVersion++;
      if (stop.type === 'pickup') {
        if (cab.onboard.length === 1) {
          var host = cab.onboard[0];
          host.hosted = true;
          host.coRiders.push(r.id);
          r.joinedOccupied = true;
          r.coRiders.push(host.id);
        }
        cab.onboard.push(r);
        r.state = 'riding';
        r.pickupAt = now;
        var Y = r.dynamicY != null ? r.dynamicY : this.Y;
        r.fare = r.fullFare * (r.pool ? 1 - Y : 1);
        this.totals.revenue += r.fare;
        this.totals.discount += r.fullFare - r.fare;
        this.totals.pickedUp++;
        this.totals.waitSum += now - r.requestAt;
      } else {
        cab.onboard.splice(cab.onboard.indexOf(r), 1);
        cab.riders.splice(cab.riders.indexOf(r), 1);
        r.state = 'done';
        r.dropoffAt = now;
        cab.trips++;
        this.totals.completed++;
        // Fairness rebate: the rider who was already aboard when a co-rider
        // boarded (the "host") absorbs more detour than the one who joined,
        // for the same flat discount. Rebate it, proportional to the extra
        // seconds this rider actually rode, capped so fare can't go negative.
        if (r.pool && r.hosted && !r.joinedOccupied && this.cfg.fairnessRebate > 0) {
          var detourSec = (r.dropoffAt - r.pickupAt) - r.est;
          if (detourSec > EPS) {
            var rebate = Math.min(r.fare, this.cfg.fairnessRebate / 100 * detourSec * this.cfg.fareRate);
            r.fare -= rebate;
            this.totals.revenue -= rebate;
            this.totals.discount += rebate;
            this.totals.fairnessRebate += rebate;
          }
        }
        if (!cab.riders.length) cab.idleSince = now;
      }
    }
  };

  // ---------------------------------------------------------------- incidents
  //
  // A declared incident is a hard keep-out zone, not a soft preference: no
  // new pickup/dropoff is ever planned inside one (enforced in evalPlan,
  // below) and no cab's route is ever allowed to drive *through* one either
  // -- checked as an exact Manhattan-diamond vs. L-route intersection, the
  // same metric the rest of the engine already uses (ping radius is drawn as
  // a diamond for the same reason), not a bolted-on Euclidean circle.
  //
  // Cabs already committed to a route when a new incident appears get an
  // immediate one-time patch (applyThreat): a pending pickup inside the zone
  // is cancelled and the rider returned to the queue to be matched safely
  // elsewhere; a drop-off inside the zone is relocated to the nearest clear
  // point and the rider is marked evacuated. Everything else -- a route that
  // merely *passes through* a live zone -- is handled continuously and
  // statelessly in advance(), every time a cab reaches an intersection, so
  // it never goes stale as zones expire or new ones appear.

  World.prototype.activeThreats = function () {
    if (!this.threats.length) return null;
    var out = null;
    for (var i = 0; i < this.threats.length; i++) {
      var th = this.threats[i];
      if (this.t >= th.at && this.t < th.at + th.duration) (out || (out = [])).push(th);
    }
    return out;
  };

  World.prototype.inThreat = function (x, y, threats) {
    if (!threats) return false;
    for (var i = 0; i < threats.length; i++) {
      if (manhattan(x, y, threats[i].x, threats[i].y) <= threats[i].radius) return true;
    }
    return false;
  };

  // Does the L-shaped route (x-leg, then y-leg -- the same order advance()
  // actually drives) from (x1,y1) to (x2,y2) pass through any active zone?
  World.prototype.legCrossesThreats = function (x1, y1, x2, y2, threats) {
    for (var i = 0; i < threats.length; i++) {
      var th = threats[i];
      if (segHitsThreat(Math.min(x1, x2), Math.max(x1, x2), y1, th, true)) return true;
      if (segHitsThreat(Math.min(y1, y2), Math.max(y1, y2), x2, th, false)) return true;
    }
    return false;
  };

  // One safe aim-point for this step, given the direct L-route to `dest` is
  // blocked: head for whichever clear "compass corner" just outside the
  // nearest blocking zone costs the least total detour, trying progressively
  // wider margins until the leg beyond the corner (not just the approach to
  // it) is clear too -- a corner that only solves the approach just defers
  // the problem to the moment the cab arrives there, forcing another pick,
  // which is the back-and-forth (expensive once turns cost time) this whole
  // search is built to avoid. Widening geometrically means this always
  // resolves in a small, bounded number of tries, never a long crawl.
  World.prototype.safeStepTarget = function (cab, dest, threats) {
    if (!this.legCrossesThreats(cab.x, cab.y, dest.x, dest.y, threats)) return dest;
    var th = null, i;
    for (i = 0; i < threats.length; i++) {
      if (this.legCrossesThreats(cab.x, cab.y, dest.x, dest.y, [threats[i]])) { th = threats[i]; break; }
    }
    var G = this.cfg.gridSize, maxM = 2 * G;
    for (var m = th.radius + 1; m <= maxM; m += Math.max(2, th.radius)) {
      var corners = [
        { x: th.x + m, y: th.y }, { x: th.x - m, y: th.y },
        { x: th.x, y: th.y + m }, { x: th.x, y: th.y - m },
      ];
      var best = null, bestCost = Infinity;
      for (i = 0; i < corners.length; i++) {
        var c = corners[i];
        c.x = Math.max(0, Math.min(G - 1, c.x));
        c.y = Math.max(0, Math.min(G - 1, c.y));
        if (this.inThreat(c.x, c.y, threats)) continue;
        if (this.legCrossesThreats(cab.x, cab.y, c.x, c.y, threats)) continue;
        if (this.legCrossesThreats(c.x, c.y, dest.x, dest.y, threats)) continue;
        var cost = manhattan(cab.x, cab.y, c.x, c.y) + manhattan(c.x, c.y, dest.x, dest.y);
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      if (best) return best;
    }
    // Every ring failed (deeply overlapping zones): take one step straight
    // away from the nearest threat's center. Always safe, always makes
    // progress, and the widening search above will succeed as soon as it does.
    var dx = Math.sign(cab.x - th.x) || 1, dy = Math.sign(cab.y - th.y) || 1;
    return { x: Math.max(0, Math.min(G - 1, cab.x + dx)), y: Math.max(0, Math.min(G - 1, cab.y + dy)) };
  };

  // The nearest point outside every active zone, used to relocate a
  // drop-off that's become unreachable.
  World.prototype.nearestSafePoint = function (x, y, threats) {
    var G = this.cfg.gridSize, best = { x: x, y: y }, bestD = Infinity;
    for (var i = 0; i < threats.length; i++) {
      var th = threats[i], m = th.radius + 1;
      var cands = [
        { x: th.x + m, y: th.y }, { x: th.x - m, y: th.y },
        { x: th.x, y: th.y + m }, { x: th.x, y: th.y - m },
      ];
      for (var k = 0; k < cands.length; k++) {
        var c = cands[k];
        c.x = Math.max(0, Math.min(G - 1, c.x));
        c.y = Math.max(0, Math.min(G - 1, c.y));
        if (this.inThreat(c.x, c.y, threats)) continue;
        var d = manhattan(x, y, c.x, c.y);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  };

  // One-time patch applied the instant a new incident is declared: strip any
  // not-yet-picked-up stop inside the zone (the rider goes back to the
  // queue), and relocate any drop-off inside the zone to the nearest safe
  // point (the rider is marked evacuated).
  World.prototype.applyThreat = function (threat) {
    var threats = [threat];
    for (var i = 0; i < this.cabs.length; i++) {
      var cab = this.cabs[i], cancelIds = {}, changed = false, k;
      for (k = 0; k < cab.plan.length; k++) {
        var s = cab.plan[k];
        if (s.type === 'pickup' && this.inThreat(s.x, s.y, threats)) cancelIds[s.rider.id] = true;
      }
      if (Object.keys(cancelIds).length) {
        cab.plan = cab.plan.filter(function (st) { return !cancelIds[st.rider.id]; });
        for (var id in cancelIds) {
          var r = this.riders[id];
          cab.riders.splice(cab.riders.indexOf(r), 1);
          r.state = 'waiting';
          r.cab = null; r.assignedAt = null; r.promisedPickupAt = null; r.latestPickupAt = null;
          r.threatCancelled++;
          this.queue.push(r);
          this.totals.threatCancellations++;
        }
        changed = true;
      }
      for (k = 0; k < cab.plan.length; k++) {
        s = cab.plan[k];
        if (this.inThreat(s.x, s.y, threats)) {
          var safe = this.nearestSafePoint(s.x, s.y, threats);
          s.x = safe.x; s.y = safe.y;
          if (!s.rider.evacuated) {
            s.rider.evacuated = true;
            s.rider.evacuatedTo = safe;
            this.totals.evacuations++;
          }
          changed = true;
        }
      }
      if (changed) { cab.planVersion++; cab.rerouteVersion++; cab.reroutes++; if (!cab.riders.length) cab.idleSince = this.t; }
    }
  };

  World.prototype.addThreat = function (threat) {
    this.threats.push(threat);
    this.totals.threatsDeclared++;
    this.applyThreat(threat);
  };

  // ---------------------------------------------------------------- planning

  function pickupStop(r) { return { type: 'pickup', rider: r, x: r.mpx, y: r.mpy }; }
  function dropoffStop(r) { return { type: 'dropoff', rider: r, x: r.mdx, y: r.mdy }; }

  // Blocks the cab must still drive to reach (x, y) directly. A cab that is
  // mid-edge finishes the edge first.
  World.prototype.reach = function (cab, x, y) {
    return cab.next
      ? 1 - cab.progress + manhattan(cab.next.x, cab.next.y, x, y)
      : manhattan(cab.x, cab.y, x, y);
  };

  // Time the plan and check every rule. Returns null if any rule breaks.
  // `newRider` is the rider being inserted (their pickup must be within the
  // ping radius); pass check=false to time a plan already committed.
  World.prototype.evalPlan = function (cab, plan, newRider, check) {
    var speed = this.speed, limit = this.cfg.maxDetour;
    var maxPick = this.cfg.pingRadius / speed;
    var t = this.t + (cab.turnDelay || 0), x, y;
    if (cab.next) {
      t += (1 - cab.progress) / speed;
      x = cab.next.x; y = cab.next.y;
    } else {
      x = cab.x; y = cab.y;
    }
    var load = cab.onboard.length;
    var picks = {}, drops = {}, newPick = null;
    var threats = check ? this.activeThreats() : null;
    var heading = cab.heading, penalty = this.cfg.turnPenaltySec;
    for (var i = 0; i < plan.length; i++) {
      var s = plan[i], r = s.rider, px = x, py = y;
      t += manhattan(x, y, s.x, s.y) / speed;
      if (penalty > 0) {
        var tp = legTurnPenalty(px, py, s.x, s.y, heading, penalty);
        t += tp.extra;
        heading = tp.heading;
      }
      x = s.x; y = s.y;
      if (threats && (this.inThreat(s.x, s.y, threats) || this.legCrossesThreats(px, py, s.x, s.y, threats))) {
        return null; // never plan a stop in, or a route through, a live incident zone
      }
      if (s.type === 'pickup') {
        load++;
        if (check) {
          if (load > 2) return null;
          if (r === newRider) {
            if (t - this.t > maxPick + EPS) return null;
          } else if (t > r.latestPickupAt + EPS) {
            return null;
          }
        }
        if (r === newRider) newPick = t;
        picks[r.id] = t;
      } else {
        load--;
        var pt = r.state === 'riding' ? r.pickupAt : picks[r.id];
        if (check && t - pt > limit * r.est + EPS) return null;
        drops[r.id] = t;
      }
    }
    return { end: t, picks: picks, drops: drops, newPick: newPick };
  };

  World.prototype.baseEval = function (cab) {
    var key = cab.planVersion + '@' + this.steps;
    if (cab._baseKey !== key) {
      cab._base = this.evalPlan(cab, cab.plan, null, false);
      cab._baseKey = key;
    }
    return cab._base;
  };

  // Best place to slot rider r into the cab's plan, by matching cost (in
  // rider-seconds): the new rider's wait, every extra in-car or waiting second
  // the change imposes on anyone, plus a weight on the extra cab-seconds.
  World.prototype.bestInsertion = function (cab, r) {
    var base = this.baseEval(cab);
    var P = pickupStop(r), D = dropoffStop(r);
    var S = cab.plan, n = S.length, best = null;
    for (var i = 0; i <= n; i++) {
      for (var j = i; j <= n; j++) {
        var plan = S.slice(0, i);
        plan.push(P);
        for (var k = i; k < j; k++) plan.push(S[k]);
        plan.push(D);
        for (k = j; k < n; k++) plan.push(S[k]);
        var res = this.evalPlan(cab, plan, r, true);
        if (!res) continue;
        var delay = 0;
        for (var id in base.drops) delay += res.drops[id] - base.drops[id];
        var cost = (res.newPick - this.t) + (res.drops[r.id] - res.newPick - r.est) + delay
          + VEHICLE_WEIGHT * (res.end - base.end);
        if (!best || cost < best.cost) {
          best = { cab: cab, plan: plan, cost: cost, res: res, base: base };
        }
      }
    }
    return best;
  };

  World.prototype.isPoolCab = function (cab) {
    if (!cab.riders.length || cab.plan.length + 2 > MAX_PLAN_STOPS) return false;
    for (var i = 0; i < cab.riders.length; i++) if (!cab.riders[i].pool) return false;
    return true;
  };

  World.prototype.commit = function (opt, r) {
    var cab = opt.cab, cfg = this.cfg;
    // Dynamic discounting: lock in this rider's rate now, from what's known
    // at the moment of matching -- whether they're joining a cab that's
    // already carrying someone (a certain match) or an idle one (a bet on a
    // future match). A quoted rate never changes after the fact.
    if (cfg.dynamicDiscount && r.pool) {
      var mult = cab.riders.length ? DYNAMIC_DISCOUNT_MATCHED : DYNAMIC_DISCOUNT_UNMATCHED;
      r.dynamicY = Math.min(0.9, (cfg.poolDiscount / 100) * mult);
    }
    var rerouted = false;
    for (var i = 0; i < cab.onboard.length; i++) {
      var a = cab.onboard[i];
      if (opt.res.drops[a.id] > opt.base.drops[a.id] + EPS) {
        a.reroutes++;
        rerouted = true;
      }
    }
    if (rerouted) {
      cab.reroutes++;
      cab.rerouteVersion++;
      this.totals.reroutes++;
    }
    cab.plan = opt.plan;
    cab.planVersion++;
    cab.reposition = null;
    cab.riders.push(r);
    r.state = 'assigned';
    r.cab = cab.id;
    r.assignedAt = this.t;
    r.promisedPickupAt = opt.res.newPick;
    r.latestPickupAt = opt.res.newPick + cfg.pickupSlip;
  };

  // ---------------------------------------------------------------- spatial index
  //
  // matchQueue/redispatch used to linearly scan every idle/poolable cab for
  // every queued rider (O(K.N) and O(N^2) per dispatch tick). Cabs are
  // bucketed into a grid keyed by position instead, so a rider only pays for
  // cabs in its own neighbourhood. nearbyCabs() returns a safe superset (a
  // cab in range is always inside it); callers still check the exact
  // distance via reach(), so this changes nothing about which cab can win --
  // only how many get looked at before the winner is found.

  World.prototype.cellKeyOf = function (x, y) {
    return Math.floor(x / this.gridCell) + ',' + Math.floor(y / this.gridCell);
  };

  World.prototype.rebuildGrid = function () {
    var grid = {}, cabs = this.cabs;
    for (var i = 0; i < cabs.length; i++) {
      var c = cabs[i], key = this.cellKeyOf(c.x, c.y);
      (grid[key] || (grid[key] = [])).push(c);
    }
    this.grid = grid;
  };

  World.prototype.nearbyCabs = function (x, y, radius, out) {
    out.length = 0;
    var cell = this.gridCell;
    var span = Math.ceil(radius / cell) + 1; // +1 covers a cab mid-edge / rounding
    var cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (var dx = -span; dx <= span; dx++) {
      for (var dy = -span; dy <= span; dy++) {
        var arr = this.grid[(cx + dx) + ',' + (cy + dy)];
        if (arr) for (var k = 0; k < arr.length; k++) out.push(arr[k]);
      }
    }
    return out;
  };

  // ---------------------------------------------------------------- adaptive radius
  //
  // The report's own ping-radius sweep shows the best radius moves with
  // supply/demand (tighter in a shortage hurts less than wider does in a
  // surplus). This runs that logic live: widen when the queue is piling up
  // relative to available cabs, tighten when cabs are plentiful. Off by
  // default -- effRadius is then just cfg.pingRadius, byte-for-byte the old
  // behaviour.

  World.prototype.updateEffectiveRadius = function (idleCount, poolableCount) {
    var cfg = this.cfg;
    if (!cfg.adaptiveRadius) { this.effRadius = cfg.pingRadius; return; }
    var supply = idleCount + poolableCount;
    var pressure = supply > 0 ? this.queue.length / supply : (this.queue.length > 0 ? 2 : 0);
    var target = cfg.pingRadius * Math.min(1.6, Math.max(0.5, 0.65 + pressure * 0.55));
    this.effRadius = this.effRadius * 0.75 + target * 0.25;
    this.effRadius = Math.max(2, Math.min(cfg.pingRadius * 1.6, this.effRadius));
  };

  // ---------------------------------------------------------------- predictive repositioning
  //
  // Idle cabs used to just sit. Now a cab idle past repositionIdleTime drifts
  // toward where demand is *predicted*, not just where it has already piled
  // up -- the difference between reactive and proactive rebalancing. The
  // prediction is a demand heatmap: a coarse grid of request counts, decayed
  // every dispatch tick (~46s half-life), built from nothing but past
  // arrivals this world has actually observed. This is the same baseline
  // technique production heatmap-based repositioning uses (observed-demand
  // grid + exponential decay) before anything fancier (forecast models,
  // optimization, RL) gets layered on top.
  //
  // Idle cabs spread across the top-K hottest cells rather than all heading
  // to the single peak -- otherwise the fleet self-defeatingly clusters on
  // one block and starves every other zone, a documented failure mode of
  // naive single-target repositioning.
  //
  // A reposition target is still a plain position outside cab.plan: it can
  // never touch the capacity/detour/radius invariants, only move an empty cab.

  World.prototype.heatIndex = function (x, y) {
    var cx = Math.min(this.heatCells - 1, Math.floor(x / this.heatStep));
    var cy = Math.min(this.heatCells - 1, Math.floor(y / this.heatStep));
    return cy * this.heatCells + cx;
  };

  // The top-K hottest cells right now, or null if no demand has been
  // observed yet (the heatmap is still bootstrapping).
  World.prototype.predictiveTargets = function () {
    if (!this.heat) return null;
    var idx = [], i;
    for (i = 0; i < this.heat.length; i++) if (this.heat[i] > 0.25) idx.push(i);
    if (!idx.length) return null;
    var heat = this.heat;
    idx.sort(function (a, b) { return heat[b] - heat[a]; });
    var out = [], n = Math.min(HEAT_TOPK, idx.length);
    for (i = 0; i < n; i++) {
      var cell = idx[i], cx = cell % this.heatCells, cy = Math.floor(cell / this.heatCells);
      out.push({
        x: Math.min(this.cfg.gridSize - 1, Math.round((cx + 0.5) * this.heatStep)),
        y: Math.min(this.cfg.gridSize - 1, Math.round((cy + 0.5) * this.heatStep)),
        heat: heat[cell],
      });
    }
    return out;
  };

  // Which of the top-K hot zones (if any) this cab should head to: whichever
  // scores best trading off how hot it is against how far away it is, so a
  // merely-warm nearby zone can beat a hotter one across the city.
  World.prototype.pickTarget = function (cab, targets, threats) {
    if (targets) {
      var best = null, bestScore = -Infinity, scale = Math.max(4, this.cfg.gridSize / 4);
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (threats && this.inThreat(t.x, t.y, threats)) continue; // never predict demand into a live incident
        var score = t.heat / (1 + manhattan(cab.x, cab.y, t.x, t.y) / scale);
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best) return { x: best.x, y: best.y };
    }
    // Heatmap has no (safe) signal yet (feature just turned on, demand is
    // genuinely uniform/noisy, or every hot cell is inside an incident):
    // fall back to drifting toward whoever is currently waiting, so cabs
    // aren't frozen while the prediction bootstraps.
    if (!this.queue.length) return null;
    var sx = 0, sy = 0, n = this.queue.length;
    for (var j = 0; j < n; j++) { sx += this.queue[j].ox; sy += this.queue[j].oy; }
    var qx = Math.round(sx / n), qy = Math.round(sy / n);
    if (threats && this.inThreat(qx, qy, threats)) return null;
    return { x: qx, y: qy };
  };

  World.prototype.updateRepositioning = function () {
    var candidates = [], i;
    for (i = 0; i < this.cabs.length; i++) {
      var c = this.cabs[i];
      if (c.riders.length || c.plan.length || c.reposition) continue;
      if (this.t - c.idleSince < this.cfg.repositionIdleTime) continue;
      candidates.push(c);
    }
    if (!candidates.length) return;
    var targets = this.predictiveTargets();
    var threats = this.threats.length ? this.activeThreats() : null;
    for (i = 0; i < candidates.length; i++) {
      var cab = candidates[i];
      var t = this.pickTarget(cab, targets, threats);
      if (!t || (cab.x === t.x && cab.y === t.y)) continue;
      cab.reposition = t;
      this.totals.repositions++;
    }
  };

  // ---------------------------------------------------------------- dispatch

  World.prototype.dispatch = function () {
    var cfg = this.cfg, now = this.t;

    // Riders who waited too long without a match give up.
    if (this.queue.length) {
      var keep = [];
      for (var q = 0; q < this.queue.length; q++) {
        var w = this.queue[q];
        if (now - w.requestAt >= cfg.patience - EPS) {
          w.state = 'lost';
          w.lostAt = now;
          this.totals.lost++;
          this.lostLog.push(w.id);
        } else {
          keep.push(w);
        }
      }
      this.queue = keep;
    }

    var idleCount = 0, poolableCount = 0, i, c;
    for (i = 0; i < this.cabs.length; i++) {
      c = this.cabs[i];
      if (!c.riders.length) idleCount++;
      else if (this.poolEnabled && this.isPoolCab(c)) poolableCount++;
    }

    this.updateEffectiveRadius(idleCount, poolableCount);
    this.rebuildGrid();

    if (this.queue.length) idleCount = this.matchQueue(idleCount, poolableCount);
    if (cfg.reassign && idleCount) this.redispatch(idleCount);
    if (cfg.reposition) {
      if (this.heat) for (var hz = 0; hz < this.heat.length; hz++) this.heat[hz] *= HEAT_DECAY;
      this.updateRepositioning();
    }
  };

  // Only cabs in nearby grid cells are even considered; every one of them
  // still has its exact drive distance checked against the radius, and
  // every candidate plan is validated by evalPlan exactly as always --
  // shared by both the sequential and batched matching policies below, so
  // the set of *feasible* options is identical either way; only which one
  // gets committed, and in what order, differs.
  World.prototype.findBest = function (r, radius, buf) {
    this.nearbyCabs(r.ox, r.oy, radius, buf);
    var best = null;
    for (var j = 0; j < buf.length; j++) {
      var c = buf[j];
      if (!(!c.riders.length || (r.pool && this.isPoolCab(c)))) continue;
      if (this.reach(c, r.ox, r.oy) > radius + EPS) continue;
      var opt = this.bestInsertion(c, r);
      if (opt && (!best || opt.cost < best.cost)) best = opt;
    }
    return best;
  };

  World.prototype.matchQueue = function (idleCount, poolableCount) {
    return this.cfg.batchMatching
      ? this.matchQueueBatched(idleCount, poolableCount)
      : this.matchQueueSequential(idleCount, poolableCount);
  };

  // Oldest-request-first: each rider claims the best cab available to them,
  // in turn, which can let a rider who happens to be earlier in the queue
  // lock in an expensive match and leave a much cheaper, nearby match for a
  // later rider unavailable, purely because of arrival order.
  World.prototype.matchQueueSequential = function (idleCount, poolableCount) {
    var radius = this.effRadius, remaining = [], scanned = 0, buf = [];
    for (var q = 0; q < this.queue.length; q++) {
      var r = this.queue[q];
      if (scanned >= MAX_QUEUE_SCAN || (idleCount <= 0 && !(r.pool && poolableCount > 0))) {
        remaining.push(r);
        continue;
      }
      scanned++;
      var best = this.findBest(r, radius, buf);
      if (!best) { remaining.push(r); continue; }
      var cab = best.cab, wasIdle = !cab.riders.length;
      this.commit(best, r);
      if (wasIdle) {
        idleCount--;
        if (r.pool && this.isPoolCab(cab)) poolableCount++;
      } else if (!this.isPoolCab(cab)) {
        poolableCount--;
      }
    }
    this.queue = remaining;
    return idleCount;
  };

  // Global batch matching: gather every queued rider's best feasible option
  // first, then commit globally cheapest-first across the whole batch
  // instead of strictly in request-arrival order -- the standard "sort by
  // cost, greedily commit non-conflicting pairs" method for weighted
  // bipartite matching, the same family of algorithm real order-dispatch
  // systems run batch assignment with. A cab accepts at most one new
  // commitment per tick either way; a second opportunity is picked up fresh
  // next tick rather than requiring a mid-batch re-evaluation of a plan that
  // just changed under it.
  World.prototype.matchQueueBatched = function (idleCount, poolableCount) {
    var radius = this.effRadius, remaining = [], scanned = 0, buf = [];
    var candidates = [];
    for (var q = 0; q < this.queue.length; q++) {
      var r = this.queue[q];
      if (scanned >= MAX_QUEUE_SCAN || (idleCount <= 0 && !(r.pool && poolableCount > 0))) {
        remaining.push(r);
        continue;
      }
      scanned++;
      var best = this.findBest(r, radius, buf);
      if (best) candidates.push({ r: r, opt: best }); else remaining.push(r);
    }
    candidates.sort(function (a, b) { return a.opt.cost - b.opt.cost; });
    var cabTaken = {};
    for (var k = 0; k < candidates.length; k++) {
      var cand = candidates[k], cab = cand.opt.cab;
      if (cabTaken[cab.id]) { remaining.push(cand.r); continue; }
      cabTaken[cab.id] = true;
      var wasIdle = !cab.riders.length;
      this.commit(cand.opt, cand.r);
      if (wasIdle) {
        idleCount--;
        if (cand.r.pool && this.isPoolCab(cab)) poolableCount++;
      } else if (!this.isPoolCab(cab)) {
        poolableCount--;
      }
    }
    this.queue = remaining;
    return idleCount;
  };

  // Re-dispatch: a rider still waiting for pickup moves to a free cab that can
  // reach them much sooner. Removing stops never makes anyone else later
  // (Manhattan distances obey the triangle inequality), so the old cab's
  // remaining riders stay within every rule -- UNLESS turns cost time: a
  // shorter route can still introduce a left turn that a longer one would
  // have avoided, so with turnPenaltySec on, the shortened plan is validated
  // the same way any other candidate plan is before it's accepted.
  World.prototype.redispatch = function (idleCount) {
    var radius = this.effRadius, speed = this.speed, buf = [];
    for (var i = 0; i < this.cabs.length && idleCount > 0; i++) {
      var c = this.cabs[i];
      if (!c.riders.length) continue;
      var waiting = c.riders.filter(function (r) { return r.state === 'assigned'; });
      for (var w = 0; w < waiting.length && idleCount > 0; w++) {
        var r = waiting[w];
        var cur = this.baseEval(c).picks[r.id] - this.t;
        if (cur < REASSIGN_MIN_GAIN) continue;
        this.nearbyCabs(r.ox, r.oy, radius, buf);
        var bestCab = null, bestEta = Infinity;
        for (var j = 0; j < buf.length; j++) {
          var cand = buf[j];
          if (cand.riders.length) continue;
          var d = this.reach(cand, r.ox, r.oy);
          if (d <= radius + EPS && d / speed < bestEta) { bestEta = d / speed; bestCab = cand; }
        }
        if (!bestCab || bestEta > cur - REASSIGN_MIN_GAIN || bestEta > cur * REASSIGN_MIN_RATIO) continue;

        var shortened = c.plan.filter(function (s) { return s.rider !== r; });
        var freshPlan = [pickupStop(r), dropoffStop(r)];
        var freshRes = null;
        if (this.cfg.turnPenaltySec > 0) {
          // A left turn can make even a direct, unshared pickup-then-dropoff
          // plan exceed the detour cap on a short trip, and a shorter plan
          // for the cab being freed up can introduce a left turn that a
          // longer one would have avoided -- neither is checked by the
          // distance-only reasoning this loop otherwise relies on, so both
          // candidate plans get the same validation any other insertion does.
          if (!this.evalPlan(c, shortened, null, true)) continue;
          freshRes = this.evalPlan(bestCab, freshPlan, r, true);
          if (!freshRes) continue;
        }
        c.plan = shortened;
        c.riders.splice(c.riders.indexOf(r), 1);
        c.planVersion++;
        if (c.onboard.length) c.rerouteVersion++;

        bestCab.plan = freshPlan;
        bestCab.reposition = null;
        bestCab.riders.push(r);
        bestCab.planVersion++;
        r.cab = bestCab.id;
        r.assignedAt = this.t;
        r.promisedPickupAt = freshRes ? freshRes.newPick : this.t + bestEta;
        r.latestPickupAt = r.promisedPickupAt + this.cfg.pickupSlip;
        r.reassigned++;
        this.totals.reassigned++;

        idleCount--;
        if (!c.riders.length) { idleCount++; c.idleSince = this.t; }
      }
    }
  };

  // ---------------------------------------------------------------- readouts

  World.prototype.live = function () {
    var shared = 0, busy = 0;
    for (var i = 0; i < this.cabs.length; i++) {
      var c = this.cabs[i];
      if (c.onboard.length === 2) shared++;
      if (c.riders.length) busy++;
    }
    var T = this.totals;
    return {
      t: this.t,
      waiting: T.requested - T.pickedUp - T.lost,
      unassigned: this.queue.length,
      riding: T.pickedUp - T.completed,
      completed: T.completed,
      lost: T.lost,
      sharedCabs: shared,
      busyCabs: busy,
      idleCabs: this.cabs.length - busy,
      avgWait: T.pickedUp ? T.waitSum / T.pickedUp : null,
      driverPay: T.driverPay,
      revenue: T.revenue,
      discount: T.discount,
    };
  };

  World.prototype.sample = function () {
    var l = this.live();
    this.series.push({
      t: this.t, waiting: l.waiting, riding: l.riding, completed: l.completed, lost: l.lost,
      sharedCabs: l.sharedCabs, idleCabs: l.idleCabs, driverPay: l.driverPay,
    });
  };

  function Simulation(input) {
    this.cfg = normalizeConfig(input);
    this.scenario = makeScenario(this.cfg);
    this.pool = new World(this.cfg, this.scenario, true);
    this.base = new World(this.cfg, this.scenario, false);
  }

  Simulation.prototype.step = function () {
    this.pool.step();
    this.base.step();
  };

  Object.defineProperty(Simulation.prototype, 't', {
    get: function () { return this.pool.t; },
  });

  Object.defineProperty(Simulation.prototype, 'done', {
    get: function () { return this.pool.t >= this.cfg.duration - EPS; },
  });

  Simulation.prototype.finish = function () {
    this.pool.sample();
    this.base.sample();
    return this;
  };

  Simulation.prototype.runToEnd = function () {
    while (!this.done) this.step();
    return this.finish();
  };

  // Declare an incident (e.g. a bomb threat) at (x, y): both twin cities see
  // the identical zone at the identical simulated instant, so the pool-vs-
  // no-pool comparison is still apples to apples under the disruption, not
  // just under normal conditions. Radius and duration are fixed per the
  // configured threatRadius/threatDuration -- only where and when are
  // chosen live.
  Simulation.prototype.declareThreat = function (x, y) {
    var cfg = this.cfg;
    x = Math.max(0, Math.min(cfg.gridSize - 1, Math.round(x)));
    y = Math.max(0, Math.min(cfg.gridSize - 1, Math.round(y)));
    var at = this.t, radius = cfg.threatRadius, duration = cfg.threatDuration;
    this.pool.addThreat({ x: x, y: y, radius: radius, at: at, duration: duration });
    this.base.addThreat({ x: x, y: y, radius: radius, at: at, duration: duration });
    return { x: x, y: y, radius: radius, at: at, duration: duration };
  };

  var api = {
    DEFAULTS: DEFAULTS,
    DT: DT,
    EPS: EPS,
    DISPATCH_EVERY: DISPATCH_EVERY,
    MAX_PLAN_STOPS: MAX_PLAN_STOPS,
    VEHICLE_WEIGHT: VEHICLE_WEIGHT,
    normalizeConfig: normalizeConfig,
    makeScenario: makeScenario,
    manhattan: manhattan,
    World: World,
    Simulation: Simulation,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PoolSim = api;
}
definePoolSim(this);
