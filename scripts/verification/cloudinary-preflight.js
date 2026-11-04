// Cloudinary preflight for private verification videos. RUN ONLY WITH OWNER APPROVAL.
//
// Proves, on the real account, BEFORE the backend change is deployed:
//   1. an upload with type 'authenticated' is accepted (the old code comment says it once hit "tier restrictions");
//   2. the unsigned delivery URL is refused (the video is really private);
//   3. the signed delivery URL streams it, including a Range request (what /api/verification-media uses);
//   4. the asset can be deleted with type 'authenticated'.
// It uploads ONE synthetic test video (passed on the command line; never a user's video) into the folder
// verification-preflight/ and deletes it at the end. Touches nothing else.
//
//   node scripts/verification/cloudinary-preflight.js <path-to-synthetic.mp4>
// Needs CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in the environment.
'use strict';
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('usage: node cloudinary-preflight.js <synthetic.mp4>'); process.exit(2); }
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const step = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); return ok; };

(async () => {
  let publicId = null;
  let allOk = true;
  try {
    const up = await cloudinary.uploader.upload(file, {
      folder: 'verification-preflight', resource_type: 'video', type: 'authenticated', format: 'mp4', overwrite: false
    });
    publicId = up.public_id;
    allOk &= step('authenticated upload accepted', !!publicId, `type=${up.type}`);

    const unsigned = cloudinary.url(publicId, { resource_type: 'video', type: 'authenticated', secure: true, format: 'mp4' });
    const r1 = await fetch(unsigned);
    allOk &= step('unsigned URL is refused', r1.status === 401 || r1.status === 403 || r1.status === 404, `HTTP ${r1.status}`);

    const signed = cloudinary.url(publicId, { resource_type: 'video', type: 'authenticated', secure: true, format: 'mp4', sign_url: true });
    const r2 = await fetch(signed);
    const full = Buffer.from(await r2.arrayBuffer());   // read it all so the connection is free
    allOk &= step('signed URL streams the video', r2.status === 200 && /video/.test(r2.headers.get('content-type') || '') && full.length > 0,
      `HTTP ${r2.status} ${r2.headers.get('content-type')} bytes=${full.length}`);
    const r3 = await fetch(signed, { headers: { Range: 'bytes=0-99' } });
    const part = Buffer.from(await r3.arrayBuffer());
    allOk &= step('signed URL supports Range (seeking)', r3.status === 206 && part.length === 100,
      `HTTP ${r3.status} bytes=${part.length} content-range=${r3.headers.get('content-range')}`);
  } catch (e) {
    allOk = false;
    const cause = e.cause ? ` cause=${e.cause.code || e.cause.name || ''} ${String(e.cause.message || '').slice(0, 100)}` : '';
    step('preflight', false, `${e.name} http=${e.http_code || 'n/a'} ${e.message ? e.message.slice(0, 120) : ''}${cause}`);
  } finally {
    if (publicId) {
      try {
        const d = await cloudinary.uploader.destroy(publicId, { resource_type: 'video', type: 'authenticated', invalidate: true });
        allOk &= step('delete with type authenticated', d.result === 'ok', d.result);
      } catch (e) { allOk = false; step('delete with type authenticated', false, e.name); }
    }
  }
  console.log(allOk ? '\nPREFLIGHT PASSED: safe to deploy with the default (authenticated).' : '\nPREFLIGHT FAILED: do not deploy; report the output.');
  process.exit(allOk ? 0 : 1);
})();
