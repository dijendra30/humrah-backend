#!/usr/bin/env node
// Sports Discovery incident MongoServerError 291 — READ-ONLY inspection of the discovery history (runs, deliveries and the
// control document) before activation. It answers, from the records themselves:
//   - what each SportsDiscoveryRun contains (status, doneReason, attempts, lease, selection, counts);
//   - whether any run ever chose recipients or sent anything, and whether any delivery exists;
//   - whether each run is a claim that failed before candidate selection (the 291 shape) and can never be resumed.
//
//   Inside the backend container (Coolify terminal):   node /app/inspect-discovery-history.js
//
// Operations used: listCollections, listIndexes, find / countDocuments / aggregate. No insert, update, delete, index
// creation or index drop. It prints no user id and no token: recipients are shown as a count only. Connection string
// exactly as diagnose-livelocation.js (HUMRAH_DIAG_MONGO_URI, else MONGODB_URI, never printed); autoIndex/autoCreate off.
//
// Exit code: 0 = the history holds only runs that chose nobody and sent nothing, and no delivery (a clean activation
// apart from those, see SPORTS_DISCOVERY_291_ACTIVATION_RECOVERY_REPORT.md); 1 = something else is in the history (do
// not activate; send the output); 2 = could not determine.
'use strict';

const DEFAULT_BACKEND = 'C:\\Users\\DIJENDRA\\Desktop\\humrah-backend-main';
const BACKEND_URI_VAR = 'MONGODB_URI';

function loadBackendMongoose() {
  const candidates = [process.env.HUMRAH_BACKEND_DIR, __dirname, process.cwd(), '/app', DEFAULT_BACKEND].filter(Boolean);
  for (const dir of candidates) {
    try { return { mongoose: require(require.resolve('mongoose', { paths: [dir] })), from: dir }; }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw Object.assign(new Error('mongoose not found in: ' + candidates.join(' ; ')), { code: 'MONGOOSE_NOT_FOUND' });
}

const iso = d => (d instanceof Date && !isNaN(d) ? d.toISOString() : d === null ? 'null' : d === undefined ? 'missing' : String(d));
const MAX_LISTED = 20;

/** The read-only evaluation, separated from the CLI so it can be tested. */
async function inspect(db, now = Date.now()) {
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  if (!names.has('users')) return { usersCollectionExists: false };
  const col = n => db.collection(n);
  const runs = names.has('sportsdiscoveryruns') ? col('sportsdiscoveryruns') : null;
  const deliveries = names.has('sportsdiscoverydeliveries') ? col('sportsdiscoverydeliveries') : null;
  const controls = names.has('sportsdiscoverycontrols') ? col('sportsdiscoverycontrols') : null;
  const plans = names.has('sportsplans') ? col('sportsplans') : null;

  const out = { usersCollectionExists: true, runs: [], runTotal: 0, deliveryTotal: 0, deliveriesByStatus: {}, control: null };
  out.userGeoIndex = !!(await col('users').indexes()).find(i => JSON.stringify(i.key) === JSON.stringify({ liveLocation: '2dsphere' }));
  if (runs) {
    out.runTotal = await runs.countDocuments({});
    for (const r of await runs.find({}, { projection: { recipients: 0 } }).sort({ createdAt: 1 }).limit(MAX_LISTED).toArray()) {
      const recipients = (await runs.aggregate([{ $match: { _id: r._id } }, { $project: { n: { $size: { $ifNull: ['$recipients', []] } } } }]).toArray())[0].n;
      const planDeliveries = deliveries ? await deliveries.countDocuments({ sportsPlanId: r.sportsPlanId }) : 0;
      const plan = plans ? await plans.findOne({ _id: r.sportsPlanId }, { projection: { createdAt: 1, startTime: 1, cardStatus: 1 } }) : null;
      const counts = r.counts || {};
      const sent = Number(counts.sent) || 0;
      const leaseActive = r.leaseUntil instanceof Date && r.leaseUntil.getTime() > now;
      out.runs.push({
        id: String(r._id), createdAt: r.createdAt, updatedAt: r.updatedAt, status: r.status, doneReason: r.doneReason ?? null,
        attempts: r.attempts, leaseUntil: r.leaseUntil ?? null, leaseActive, selectedAt: r.selectedAt ?? null, recipients, counts,
        planDeliveries,
        plan: plan ? { exists: true, createdAt: plan.createdAt, startInPast: plan.startTime instanceof Date ? plan.startTime.getTime() < now : null, cardStatus: plan.cardStatus } : { exists: false },
        // A run with selectedAt null never chose anyone; recipients are only walked after selection (processRun), so it
        // cannot have sent. This is the shape a claim leaves when the candidate query fails (MongoServerError 291).
        choseNobodySentNothing: !r.selectedAt && recipients === 0 && sent === 0 && planDeliveries === 0,
      });
    }
  }
  if (deliveries) {
    out.deliveryTotal = await deliveries.countDocuments({});
    for (const row of await deliveries.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()) out.deliveriesByStatus[row._id] = row.n;
  }
  if (controls) {
    const c = await controls.findOne({ _id: 'global' });
    if (c) out.control = {
      trippedAt: c.trippedAt ?? null, tripReason: c.tripReason ?? null, lastTrip: c.lastTrip ?? null, rearmedAt: c.rearmedAt ?? null,
      consecutiveErrorTicks: c.consecutiveErrorTicks ?? 0, lastTickAt: c.lastTickAt ?? null, lastTick: c.lastTick ?? null,
      lastHeartbeatAt: c.lastHeartbeatAt ?? null, activation: c.activation ?? null,
    };
  }
  const listedAll = out.runs.length === out.runTotal;
  out.checks = {
    allRunsChoseNobodySentNothing: listedAll && out.runs.every(r => r.choseNobodySentNothing),
    noRunInProgress: listedAll && out.runs.every(r => !r.leaseActive),
    noRunCompletedSelection: listedAll && out.runs.every(r => !r.selectedAt),
    noRunCompleted: listedAll && out.runs.every(r => r.doneReason !== 'completed'),
    zeroDeliveries: out.deliveryTotal === 0,
    breakerClear: !(out.control && out.control.trippedAt),
    userGeoIndexPresent: out.userGeoIndex,
  };
  out.cleanApartFromUnsentRuns = Object.values(out.checks).every(Boolean);
  return out;
}

module.exports = { inspect };

if (require.main === module) {
  (async () => {
    if (process.argv.some(a => /^mongodb(\+srv)?:\/\//i.test(a))) { console.error('Do not put the connection string on the command line.'); process.exitCode = 2; return; }
    const { mongoose, from } = loadBackendMongoose();
    console.log(`using mongoose ${mongoose.version} from ${from}`);
    let uri;
    if (process.env.HUMRAH_DIAG_MONGO_URI) { uri = process.env.HUMRAH_DIAG_MONGO_URI; console.log('connection string: taken from HUMRAH_DIAG_MONGO_URI (not shown)'); }
    else if (process.env[BACKEND_URI_VAR]) { uri = process.env[BACKEND_URI_VAR]; console.log(`connection string: using existing backend MongoDB configuration (${BACKEND_URI_VAR}, not shown)`); }
    else { console.error(`could not run: neither HUMRAH_DIAG_MONGO_URI nor ${BACKEND_URI_VAR} is set`); process.exitCode = 2; return; }
    if (!/^mongodb(\+srv)?:\/\//i.test(uri)) { console.error('could not run: not a mongodb connection string (not shown)'); process.exitCode = 2; return; }
    // Gate settings are configuration, not secrets: shown so the output says what the server is configured to do.
    console.log(`SPORTS_DISCOVERY_ENABLED=${process.env.SPORTS_DISCOVERY_ENABLED ?? '(unset)'}   SPORTS_DISCOVERY_STARTED_AT=${process.env.SPORTS_DISCOVERY_STARTED_AT ?? '(unset)'}`);
    const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false }).asPromise();
    uri = null;
    try {
      const r = await inspect(conn.db);
      if (!r.usersCollectionExists) { console.error('could not run: the configured database has no "users" collection (nothing concluded).'); process.exitCode = 2; return; }
      console.log(`\nusers { liveLocation: "2dsphere" } index: ${r.userGeoIndex ? 'PRESENT' : 'MISSING'}`);
      console.log(`\nSportsDiscoveryRun records: ${r.runTotal}${r.runTotal > r.runs.length ? ` (first ${r.runs.length} listed)` : ''}`);
      for (const x of r.runs) {
        console.log(`\n  run ${x.id}`);
        console.log(`    createdAt ${iso(x.createdAt)}   updatedAt (last claim/close) ${iso(x.updatedAt)}`);
        console.log(`    status ${x.status}   doneReason ${x.doneReason}   attempts ${x.attempts}   leaseUntil ${iso(x.leaseUntil)}${x.leaseActive ? ' (ACTIVE)' : ' (expired)'}`);
        console.log(`    selectedAt ${iso(x.selectedAt)}   recipients ${x.recipients}   counts ${JSON.stringify(x.counts)}`);
        console.log(`    delivery rows for its plan: ${x.planDeliveries}`);
        console.log(`    its plan: ${x.plan.exists ? `createdAt ${iso(x.plan.createdAt)}, start ${x.plan.startInPast ? 'in the past' : 'in the future'}, cardStatus ${x.plan.cardStatus}` : 'no longer exists'}`);
        console.log(`    => ${x.choseNobodySentNothing ? 'chose NOBODY and sent NOTHING (a claim that failed before candidate selection)' : 'NOT a claim without selection: it chose recipients or sent'}`);
      }
      console.log(`\nSportsDiscoveryDelivery records: ${r.deliveryTotal}   by status: ${JSON.stringify(r.deliveriesByStatus)}`);
      if (r.control) {
        const c = r.control;
        console.log(`\ncontrol: trippedAt ${iso(c.trippedAt)} (${c.tripReason})   rearmedAt ${iso(c.rearmedAt)}   consecutiveErrorTicks ${c.consecutiveErrorTicks}`);
        console.log(`         lastTickAt ${iso(c.lastTickAt)}   lastTick ${JSON.stringify(c.lastTick)}`);
        console.log(`         lastHeartbeatAt ${iso(c.lastHeartbeatAt)}   activation ${JSON.stringify(c.activation)}`);
      } else console.log('\ncontrol: no control document');
      console.log('\nchecks:');
      for (const [k, v] of Object.entries(r.checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
      if (r.cleanApartFromUnsentRuns && r.runTotal === 0) {
        console.log('\nRESULT: no run and no delivery: a genuinely clean activation.');
        process.exitCode = 0;
      } else if (r.cleanApartFromUnsentRuns) {
        console.log(`\nRESULT: the history holds ${r.runTotal} run(s) that chose nobody and sent nothing, and no delivery. Nobody has ever been notified.`);
        console.log('Keep the run(s). The activation check accepts them only when acknowledged: check-readiness.js --phase pre --accept-unsent-runs ' + r.runTotal);
        process.exitCode = 0;
      } else {
        console.log('\nRESULT: the history holds something other than unsent claims (see the FAIL lines). Do NOT activate; send this output.');
        process.exitCode = 1;
      }
    } finally { await conn.close(); }
  })().catch(e => {
    const own = ['MONGOOSE_NOT_FOUND'].includes(e.code);
    console.error('could not run:', own ? e.message : `${e.name} ${e.code || e.codeName || ''}`.trim());
    process.exitCode = 2;
  });
}
