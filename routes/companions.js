// routes/companions.js
'use strict';

const express = require('express');
const https   = require('https');
const qs      = require('querystring');
const router  = express.Router();

const { auth, authenticate } = require('../middleware/auth');
const User  = require('../models/User');
const admin = require('firebase-admin');

// =============================================================================
// HELPERS
// =============================================================================

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dL = (lat2-lat1)*Math.PI/180, dG = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getRadiusKm() { const h = new Date().getHours(); return (h >= 21 || h < 6) ? 2 : 5; }
function isNightTime() { const h = new Date().getHours(); return h >= 21 || h < 6; }

// =============================================================================
// MOOD PLACES — cache + Overpass fetch + city fallback
// =============================================================================

const moodPlacesCache = new Map();
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;

function _cacheKey(lat, lng) { return `${Math.round(lat*100)/100}_${Math.round(lng*100)/100}`; }
function _cacheValid(e, lat, lng) {
  if (!e) return false;
  if (Date.now() - e.fetchedAt > CACHE_TTL_MS) return false;
  if (haversineKm(lat, lng, e.lat, e.lng) > 1) return false;
  return true;
}

const CITY_COORDS = {
  'Delhi':[28.6139,77.2090],'New Delhi':[28.6139,77.2090],
  'Mumbai':[19.0760,72.8777],'Bangalore':[12.9716,77.5946],
  'Bengaluru':[12.9716,77.5946],'Hyderabad':[17.3850,78.4867],
  'Chennai':[13.0827,80.2707],'Kolkata':[22.5726,88.3639],
  'Pune':[18.5204,73.8567],'Ahmedabad':[23.0225,72.5714],
  'Jaipur':[26.9124,75.7873],'Surat':[21.1702,72.8311],
  'Lucknow':[26.8467,80.9462],'Kanpur':[26.4499,80.3319],
  'Nagpur':[21.1458,79.0882],'Indore':[22.7196,75.8577],
  'Bhopal':[23.2599,77.4126],'Patna':[25.5941,85.1376],
  'Noida':[28.5355,77.3910],'Gurgaon':[28.4595,77.0266],
  'Gurugram':[28.4595,77.0266],'Faridabad':[28.4089,77.3178],
  'Chandigarh':[30.7333,76.7794],'Coimbatore':[11.0168,76.9558],
  'Kochi':[9.9312,76.2673],'Bhubaneswar':[20.2961,85.8245],
  'Guwahati':[26.1445,91.7362],'Visakhapatnam':[17.6868,83.2185],
};

const MOOD_OSM = {
  'Cafe Mood':    {q:[['amenity','cafe|coffee_shop|bakery']],                                                                                             label:'cafes',         r:2000,fb:5000},
  'Food Mood':    {q:[['amenity','restaurant|food_court|fast_food|bar']],                                                                                 label:'food places',   r:2000,fb:5000},
  'Walk Mood':    {q:[['leisure','park|garden|nature_reserve|playground']],                                                                               label:'parks',         r:4000,fb:8000},
  'Talk Mood':    {q:[['amenity','cafe|community_centre|library|restaurant']],                                                                            label:'spots',         r:3000,fb:6000},
  'Study Mood':   {q:[['amenity','library|cafe|university|college']],                                                                                     label:'study spots',   r:3000,fb:6000},
  'Explore Mood': {q:[['tourism','attraction|museum|viewpoint|gallery|theme_park|zoo'],['historic','monument|memorial|fort'],['railway','station']],      label:'explore spots', r:5000,fb:10000},
  'Chill Mood':   {q:[['leisure','park|garden|pitch|nature_reserve']],                                                                                    label:'chill spots',   r:4000,fb:8000},
  'Photo Mood':   {q:[['tourism','attraction|viewpoint|museum|artwork|gallery'],['historic','monument|memorial|fort'],['natural','peak|water|wood|cliff|beach'],['leisure','park|garden']], label:'photo spots', r:5000,fb:10000},
  'Shop Mood':    {q:[['shop','mall|supermarket|department_store|clothes'],['amenity','marketplace']],                                                    label:'shopping spots',r:3000,fb:6000},
  'Night Mood':   {q:[['amenity','cafe|bar|cinema|restaurant|theatre']],                                                                                  label:'safe spots',    r:2000,fb:4000},
  'Fitness Mood': {q:[['leisure','fitness_centre|sports_centre|pitch|stadium|swimming_pool'],['amenity','gym'],['sport','fitness|gym|swimming|tennis']],  label:'fitness spots', r:3000,fb:6000},
};

function _buildQuery(lat, lng, r, queries) {
  const parts = queries.map(([k,v]) =>
    `node(around:${r},${lat},${lng})["${k}"~"${v}"];way(around:${r},${lat},${lng})["${k}"~"${v}"];`
  ).join('');
  return `[out:json][timeout:15];(${parts});out tags 30;`;
}

function _parse(body) {
  const count = (body.match(/"type"\s*:\s*"(node|way)"/g)||[]).length;
  const nm    = [...body.matchAll(/"name"\s*:\s*"([^"]+)"/g)];
  const names = [...new Set(nm.map(m=>m[1].trim()).filter(Boolean))].slice(0,3);
  return {count,names};
}

function _runQuery(lat, lng, r, queries) {
  return new Promise(resolve => {
    const data = qs.stringify({data: _buildQuery(lat,lng,r,queries)});
    const opts = {
      hostname:'overpass-api.de', path:'/api/interpreter', method:'POST', timeout:14000,
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(data)}
    };
    const req = https.request(opts, res => {
      let body='';
      res.on('data',d=>body+=d);
      res.on('end',()=>{ try{resolve(_parse(body));}catch{resolve({count:0,names:[]});} });
    });
    req.on('error',()=>resolve({count:0,names:[]}));
    req.on('timeout',()=>{req.destroy();resolve({count:0,names:[]});});
    req.write(data); req.end();
  });
}

async function _fetchMood(lat, lng, cfg, night) {
  const initR = night ? Math.min(cfg.r, 2000) : cfg.r;
  const first = await _runQuery(lat, lng, initR, cfg.q);
  if (first.count >= 3) return {...first, label:cfg.label};
  const second = await _runQuery(lat, lng, cfg.fb, cfg.q);
  return {...(second.count > first.count ? second : first), label:cfg.label};
}

// =============================================================================
// GET /api/companions/mood-places
// One request — all 11 moods parallel — cached 24h by location
// =============================================================================

router.get('/mood-places', authenticate, async (req, res) => {
  try {
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng questionnaire').lean();
    if (!me) return res.json({success:false, places:{}, message:'User not found'});

    let lat = me.last_known_lat, lng = me.last_known_lng;

    if (lat == null || lng == null) {
      const city   = me.questionnaire?.city?.trim();
      const coords = city ? CITY_COORDS[city] : null;
      if (!coords) return res.json({success:true, places:{}, cached:false, message:'location_pending'});
      [lat, lng] = coords;
    }

    const key = _cacheKey(lat, lng), entry = moodPlacesCache.get(key);
    if (_cacheValid(entry, lat, lng)) return res.json({success:true, places:entry.data, cached:true});

    const night = isNightTime();
    const settled = await Promise.allSettled(
      Object.entries(MOOD_OSM).map(([mk, cfg]) =>
        _fetchMood(lat, lng, cfg, night)
          .then(r  => ({mk, count:r.count, names:r.names, label:r.label}))
          .catch(() => ({mk, count:0, names:[], label:cfg.label}))
      )
    );

    const data = {};
    settled.forEach(r => {
      if (r.status==='fulfilled') {
        const {mk,count,names,label} = r.value;
        data[mk] = {count, names, label};
      }
    });

    moodPlacesCache.set(key, {data, fetchedAt:Date.now(), lat, lng});
    if (moodPlacesCache.size > 500) {
      const oldest = [...moodPlacesCache.entries()].sort((a,b)=>a[1].fetchedAt-b[1].fetchedAt)[0];
      moodPlacesCache.delete(oldest[0]);
    }

    return res.json({success:true, places:data, cached:false});
  } catch (err) {
    console.error('[mood-places]', err.message);
    res.status(500).json({success:false, places:{}, message:'Server error'});
  }
});

// =============================================================================
// GET /api/companions/mood-matches
// =============================================================================

function calcCompatScore(me, other, maxKm) {
  const mm=me.dailyMood, om=other.dailyMood;
  const moodM  = (mm.moods.filter(m=>om.moods.includes(m)).length/(Math.max(mm.moods.length,om.moods.length)||1))*40;
  const energM = Math.max(0,1-Math.abs((mm.energyLevel||5)-(om.energyLevel||5))/9)*25;
  const openM  = (mm.openTo.filter(a=>om.openTo.includes(a)).length/(Math.max(mm.openTo.length,om.openTo.length)||1))*20;
  const myI    = me.questionnaire?.interests||me.questionnaire?.hangoutPreferences||[];
  const thI    = other.questionnaire?.interests||other.questionnaire?.hangoutPreferences||[];
  const intM   = (myI.filter(i=>thI.includes(i)).length/(Math.max(myI.length,thI.length)||1))*10;
  const distKm = haversineKm(me.last_known_lat,me.last_known_lng,other.last_known_lat,other.last_known_lng);
  const distB  = Math.max(0,1-distKm/maxKm)*5;
  return Math.round(moodM+energM+openM+intM+distB);
}

router.get('/mood-matches', authenticate, async (req, res) => {
  try {
    const now=new Date(), MAX_KM=getRadiusKm(), night=isNightTime();
    const me = await User.findById(req.userId)
      .select('last_known_lat last_known_lng last_location_updated_at dailyMood questionnaire blockedUsers status').lean();
    if (!me) return res.status(404).json({success:false, message:'User not found'});

    if (!me.dailyMood?.expiresAt || new Date(me.dailyMood.expiresAt)<=now)
      return res.json({success:true, users:[], noMoodSet:true, message:'Set your mood first'});

    const locationAge = me.last_location_updated_at ? (now-new Date(me.last_location_updated_at))/3600000 : 999;
    if (locationAge>24 || me.last_known_lat==null)
      return res.json({success:true, users:[], noMoodSet:false, message:'Share your location to find matches'});

    const blockedIds = (me.blockedUsers||[]).map(id=>id.toString());
    const dLat = MAX_KM/111.0;
    const dLng = MAX_KM/(111.0*Math.cos(me.last_known_lat*Math.PI/180));

    const candidates = await User.find({
      _id:{$ne:req.userId,$nin:blockedIds}, status:'ACTIVE',
      last_location_updated_at:{$gte:new Date(now-86400000)},
      last_known_lat:{$gte:me.last_known_lat-dLat,$lte:me.last_known_lat+dLat},
      last_known_lng:{$gte:me.last_known_lng-dLng,$lte:me.last_known_lng+dLng},
      'dailyMood.expiresAt':{$gt:now}, 'dailyMood.visible':true,
    }).select('firstName age profilePhoto verified photoVerificationStatus last_known_lat last_known_lng dailyMood questionnaire').lean();

    const results = [];
    for (const c of candidates) {
      if (c.last_known_lat==null||c.last_known_lng==null) continue;
      const distKm = haversineKm(me.last_known_lat,me.last_known_lng,c.last_known_lat,c.last_known_lng);
      if (distKm>MAX_KM) continue;
      results.push({
        _id:c._id, firstName:c.firstName, age:c.age||null,
        profilePhoto:c.profilePhoto, verified:c.verified,
        photoVerificationStatus:c.photoVerificationStatus||null,
        distanceKm:Math.round(distKm*10)/10,
        compatibilityScore:calcCompatScore(me,c,MAX_KM),
        dailyMood:{moods:c.dailyMood.moods,energyLevel:c.dailyMood.energyLevel,openTo:c.dailyMood.openTo}
      });
    }

    results.sort(night
      ? (a,b)=>(b.verified?1:0)-(a.verified?1:0)||b.compatibilityScore-a.compatibilityScore
      : (a,b)=>b.compatibilityScore-a.compatibilityScore
    );

    return res.json({success:true, users:results.slice(0,10), noMoodSet:false, expiresAt:me.dailyMood.expiresAt});
  } catch (err) {
    console.error('[mood-matches]', err.message);
    res.status(500).json({success:false, message:'Server error'});
  }
});

// =============================================================================
// POST /api/companions/mood-request
// =============================================================================

router.post('/mood-request', authenticate, async (req, res) => {
  try {
    const {receiverId, message} = req.body;
    if (!receiverId) return res.status(400).json({success:false, message:'receiverId required'});
    if (message && message.length>200) return res.status(400).json({success:false, message:'Message too long'});

    const now=new Date(), MAX_KM=getRadiusKm();
    const [me, receiver] = await Promise.all([
      User.findById(req.userId).select('last_known_lat last_known_lng dailyMood blockedUsers firstName moodRequestsSent').lean(),
      User.findById(receiverId).select('last_known_lat last_known_lng dailyMood blockedUsers fcmTokens firstName').lean()
    ]);

    if (!receiver) return res.status(404).json({success:false, message:'User not found'});
    if (!me.dailyMood?.expiresAt||new Date(me.dailyMood.expiresAt)<=now||
        !receiver.dailyMood?.expiresAt||new Date(receiver.dailyMood.expiresAt)<=now)
      return res.status(400).json({success:false, message:'Both users must have an active mood'});
    if (me.last_known_lat==null||receiver.last_known_lat==null)
      return res.status(400).json({success:false, message:'Location required'});

    const distKm = haversineKm(me.last_known_lat,me.last_known_lng,receiver.last_known_lat,receiver.last_known_lng);
    if (distKm>MAX_KM) return res.status(400).json({success:false, message:`User not within ${MAX_KM}km`});

    const blockedByRec = (receiver.blockedUsers||[]).map(id=>id.toString());
    const blockedByMe  = (me.blockedUsers||[]).map(id=>id.toString());
    if (blockedByRec.includes(req.userId.toString())||blockedByMe.includes(receiverId.toString()))
      return res.status(403).json({success:false, message:'Unable to send request'});

    const lastSent = me.moodRequestsSent?.[receiverId];
    const COOL = 3600000;
    if (lastSent&&(now-new Date(lastSent))<COOL) {
      const wait = Math.ceil((COOL-(now-new Date(lastSent)))/60000);
      return res.status(429).json({success:false, message:`Wait ${wait} min before requesting again`});
    }
    User.findByIdAndUpdate(req.userId,{$set:{[`moodRequestsSent.${receiverId}`]:now}}).exec();

    const notifMsg = message?.trim()||`${me.firstName} wants to connect — you both share similar vibes today ☕`;
    if (receiver.fcmTokens?.length>0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens:receiver.fcmTokens,
          notification:{title:`${me.firstName} wants to connect ✨`,body:notifMsg},
          data:{type:'mood_request',senderId:req.userId.toString(),senderName:me.firstName},
          android:{priority:'normal'}
        });
      } catch(e) { console.error('[mood-request] FCM (non-fatal):', e.message); }
    }

    return res.json({success:true, message:'Mood request sent!', notificationSent:(receiver.fcmTokens?.length||0)>0});
  } catch (err) {
    console.error('[mood-request]', err.message);
    res.status(500).json({success:false, message:'Server error'});
  }
});

// =============================================================================
// COMPANION LIST ROUTES (wildcard /:companionId must be LAST)
// =============================================================================

router.get('/recommended', auth, async (req, res) => {
  try {
    const u = await User.findById(req.userId);
    if (!u?.questionnaire) return res.status(400).json({success:false, message:'Complete your profile first'});
    const f = {_id:{$ne:req.userId}, userType:'COMPANION', status:'ACTIVE'};
    if (u.questionnaire.city) f['questionnaire.city']=u.questionnaire.city;
    if (u.questionnaire.interests?.length) f['questionnaire.interests']={$in:u.questionnaire.interests};
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(10).sort({'ratingStats.averageRating':-1,lastActive:-1});
    res.json({success:true, companions});
  } catch(err) { res.status(500).json({success:false, message:'Server error'}); }
});

router.get('/', auth, async (req, res) => {
  try {
    const {interests,city,state,limit=20} = req.query;
    const f = {_id:{$ne:req.userId}, userType:'COMPANION', status:'ACTIVE'};
    if (interests) f['questionnaire.interests']={$in:interests.split(',')};
    if (city)      f['questionnaire.city']=city;
    if (state)     f['questionnaire.state']=state;
    const companions = await User.find(f)
      .select('firstName lastName profilePhoto questionnaire ratingStats verified isPremium userType')
      .limit(parseInt(limit)).sort({isPremium:-1,'ratingStats.averageRating':-1,lastActive:-1});
    res.json({success:true, companions});
  } catch(err) { res.status(500).json({success:false, message:'Server error'}); }
});

router.get('/:companionId', auth, async (req, res) => {
  try {
    const c = await User.findOne({_id:req.params.companionId, userType:'COMPANION', status:'ACTIVE'})
      .select('-password -emailVerificationOTP -fcmTokens');
    if (!c) return res.status(404).json({success:false, message:'Companion not found'});
    res.json({success:true, companion:c.getPublicProfile()});
  } catch(err) { res.status(500).json({success:false, message:'Server error'}); }
});

module.exports = router;
