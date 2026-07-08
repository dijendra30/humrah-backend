'use strict';
/**
 * cronJobs/officialEventsCron.js
 *
 * Two responsibilities, run independently every 5 minutes:
 *  1. Auto-publish Scheduled events whose scheduledPublishAt has arrived.
 *  2. Auto-expire Published events whose date has passed (with 1-hour buffer
 *     so events that run at the listed date still show as Published during the day).
 */

const OfficialEvent = require('../models/OfficialEvent');

async function runOfficialEventsCron() {
  const now = new Date();

  try {
    // ── 1. Scheduled → Published ──────────────────────────────────────────────
    const published = await OfficialEvent.updateMany(
      { status: 'Scheduled', scheduledPublishAt: { $lte: now } },
      { $set: { status: 'Published' } }
    );
    if (published.modifiedCount > 0) {
      console.log(`[OfficialEventsCron] ✅ Auto-published ${published.modifiedCount} event(s)`);
    }

    // ── 2. Published → Expired ────────────────────────────────────────────────
    // Fetch all published events and check precise expiration (date + endTime)
    const { isEventExpired } = require('../helpers/eventEligibility');
    const activeEvents = await OfficialEvent.find({ status: 'Published' });
    let expiredCount = 0;
    
    for (const event of activeEvents) {
      if (isEventExpired(event)) {
        await OfficialEvent.updateOne({ _id: event._id }, { $set: { status: 'Expired' } });
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      console.log(`[OfficialEventsCron] ⏰ Auto-expired ${expiredCount} event(s)`);
    }
  } catch (err) {
    console.error('[OfficialEventsCron] ❌ Error:', err.message);
  }
}

module.exports = { runOfficialEventsCron };
