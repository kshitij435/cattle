// =========================================================================
// APP CORE -- camera capture, video recording, gallery upload, live AI
// detection, UI rendering (chips/thumbnails/progress/details panel), and
// claim export. Kept together deliberately rather than split further --
// see chat: this is the most tightly-coupled part of the original app
// (shared mutable state read/written from dozens of places, ~100 DOM
// element references interleaved throughout), and safely separating it
// further needs live browser/camera testing at each step, not a blind
// mechanical split. Config, forensics, and geo were genuinely safe to
// extract into their own modules; this core is not, yet.
//
// Adapted from the original index.html: every reference to the shared
// state variables (currentStepIdx, stepSide, captures, currentDomain,
// currentStream, audioAvailable, facingMode, lastLocation, locationStatus)
// now reads/writes them via the shared `state` object instead of bare
// module-level variables, so this stays correctly wired to the same state
// other modules use. Logic itself is otherwise unchanged from the original.
// =========================================================================
import { state } from './state.js';
// onnxruntime-web is loaded via CDN <script> tag (see index.html), NOT an
// npm import, unlike exifr elsewhere in this app. This is deliberate: its
// own source uses asset-reference patterns that trigger bundlers (Vite
// included) to statically bundle a WASM backend file directly into the
// production output -- measured at 26.8MB, the largest
// variant, regardless of what a given device actually needs. Standard
// Vite config fixes (optimizeDeps.exclude, output externals) didn't
// resolve this at the production-build level, and further attempts
// weren't verifiable without a live browser to test against. Keeping it
// as a CDN script tag (matching the original, already-proven-working
// app) avoids the problem entirely: onnxruntime-web fetches only the ONE
// WASM variant a given device actually needs, dynamically, at runtime --
// exactly the original app's behavior. `ort` below is the CDN-loaded
// global, matching the original code's usage throughout this file.
import { DEAD_STEPS, LIVE_STEPS } from './config/steps.js';
import { BORDERS } from './config/borders.js';
import { REFERENCE_PHOTOS } from './config/reference-photos.js';
import { COCO_MODEL_CONFIG, CATTLE_MODEL_CONFIG, SECONDARY_MODEL_CONFIG } from './config/models.js';
import { generateELA, computeTamperVerdict } from './forensics/forensics.js';
import { parseExifGPSAndDate } from './geo/exif.js';
import { generateGeotagImage } from './geo/geotag-image.js';
import {
  activeStepList, allNavSteps, requiredSteps, currentStep,
  referenceKeyFor, borderKeyFor, sourceLabelFor,
  isDualSideStep, sidesForDualStep, captureKey, stepIsDone,
  representativeCapture, findGeotagSourceCap
} from './capture/capture-keys.js';

// Sets a default "left" side for every sided step (Flank, Head, Live
// Flank), so guide overlays and captureKey() produce valid results from
// the very first load -- not just after the person happens to tap a side
// toggle button at least once. This exact initialization line was present
// in the original app but got left behind during the modular extraction
// (found via real device testing -- see chat: same root cause as the
// earlier reverseGeocode/measureWrappedLines/drawPinIcon bugs, code that
// existed right alongside logic that DID get moved, but wasn't itself
// carried over). MUST run before selectStep(0) in the Init section below.
[...DEAD_STEPS, ...LIVE_STEPS].forEach(s => { if(s.sided) state.stepSide[s.id] = "left"; });

const chipScroll   = document.getElementById('chipScroll');
const sideToggle    = document.getElementById('sideToggle');
const sideLeftBtn   = document.getElementById('sideLeftBtn');
const sideRightBtn  = document.getElementById('sideRightBtn');
const thumbStrip    = document.getElementById('thumbStrip');
const guideMain     = document.getElementById('guideMain');
const guideHalo     = document.getElementById('guideHalo');
const guideLabel    = document.getElementById('guideLabel');
const camHint       = document.getElementById('camHint');
const camHintText   = document.getElementById('camHintText');
const reqNote       = document.getElementById('reqNote');
const video         = document.getElementById('video');
const frameImg      = document.getElementById('frameImg');
const playbackVideo = document.getElementById('playbackVideo');
const elaImg         = document.getElementById('elaImg');
const elaToggleBtn   = document.getElementById('elaToggleBtn');
const elaControls      = document.getElementById('elaControls');
const elaQualitySlider = document.getElementById('elaQualitySlider');
const elaOpacitySlider = document.getElementById('elaOpacitySlider');
const elaQualityVal    = document.getElementById('elaQualityVal');
const elaOpacityVal    = document.getElementById('elaOpacityVal');
const elaRegenStatus   = document.getElementById('elaRegenStatus');
const ELA_AMPLIFY_FIXED = 15;   // fixed now that amplification isn't a user-facing slider
let currentCapForEla = null;   // the capture currently being reviewed, so sliders know what to regenerate from
let elaRegenTimeout = null;

async function regenerateElaFromSliders(){
  if(!currentCapForEla) return;
  const quality = parseInt(elaQualitySlider.value, 10) / 100;
  elaQualityVal.textContent = elaQualitySlider.value + "%";
  elaRegenStatus.textContent = "Regenerating...";
  elaImg.classList.add('regenerating');   // dim the PREVIOUS result instead of it vanishing while the new one computes
  try{
    const newEla = await generateELA(currentCapForEla.dataUrl, quality, ELA_AMPLIFY_FIXED, 900);
    currentCapForEla.elaDataUrl = newEla;   // keep the capture's stored version in sync too
    elaImg.src = newEla;
    elaRegenStatus.textContent = "";
  }catch(err){
    console.warn("ELA regeneration failed:", err);
    elaRegenStatus.textContent = "Regeneration failed — try again.";
  } finally {
    elaImg.classList.remove('regenerating');
  }
}
function scheduleElaRegen(){
  clearTimeout(elaRegenTimeout);
  elaRegenStatus.textContent = "Adjusting...";
  elaRegenTimeout = setTimeout(regenerateElaFromSliders, 300);   // debounced -- avoids regenerating on every tiny drag tick
}
// Opacity is a pure CSS change -- instant, no regeneration needed. At 0
// the heatmap is fully transparent, so the ORIGINAL photo underneath
// shows through completely, letting you compare by dragging back and
// forth rather than a hard on/off toggle.
function applyElaOpacity(){
  const pct = parseInt(elaOpacitySlider.value, 10);
  elaOpacityVal.textContent = pct + "%";
  elaImg.style.opacity = pct / 100;
}
elaQualitySlider.addEventListener('input', scheduleElaRegen);
elaOpacitySlider.addEventListener('input', applyElaOpacity);
const recIndicator  = document.getElementById('recIndicator');
const recCountdownText = document.getElementById('recCountdownText');
const viewfinder    = document.getElementById('viewfinder');
const shutterBtn    = document.getElementById('shutterBtn');
const switchBtn     = document.getElementById('switchBtn');
const galleryBtn    = document.getElementById('galleryBtn');
const refBtn         = document.getElementById('refBtn');
const refBtnThumb    = document.getElementById('refBtnThumb');
const refLightbox        = document.getElementById('refLightbox');
const refLightboxImg     = document.getElementById('refLightboxImg');
const refLightboxCaption = document.getElementById('refLightboxCaption');
const refLightboxClose   = document.getElementById('refLightboxClose');

// ---------- Custom in-app alert (replaces native alert(), which shows the
// site's URL as an uneditable browser-controlled title bar) ----------
const appAlertBackdrop = document.getElementById('appAlertBackdrop');
const appAlertText     = document.getElementById('appAlertText');
const appAlertOk       = document.getElementById('appAlertOk');
function showAppAlert(message){
  return new Promise((resolve) => {
    appAlertText.textContent = message;
    appAlertBackdrop.classList.add('show');
    const onOk = () => {
      appAlertBackdrop.classList.remove('show');
      appAlertOk.removeEventListener('click', onOk);
      resolve();
    };
    appAlertOk.addEventListener('click', onOk);
  });
}
const fileInput     = document.getElementById('fileInput');
const camError      = document.getElementById('camError');
const progressFill  = document.getElementById('progressFill');
const progressCount = document.getElementById('progressCount');
const gpsPill       = document.getElementById('gpsPill');
const metaBar       = document.getElementById('metaBar');
const metaTime      = document.getElementById('metaTime');
const metaGps       = document.getElementById('metaGps');
const exportBtn     = document.getElementById('exportBtn');
const faceBox       = document.getElementById('faceBox');
const partBox       = document.getElementById('partBox');
const partBox2      = document.getElementById('partBox2');
const partBox2Tag   = document.getElementById('partBox2Tag');
const partBox3      = document.getElementById('partBox3');
const partBox3Tag   = document.getElementById('partBox3Tag');
const partBoxTag    = document.getElementById('partBoxTag');
const demoBadge     = document.getElementById('demoBadge');
const brandSubtitle = document.getElementById('brandSubtitle');
const modeDeadBtn   = document.getElementById('modeDeadBtn');
const modeLiveBtn   = document.getElementById('modeLiveBtn');


function switchDomain(domain){
  if(domain === state.currentDomain) return;
  state.currentDomain = domain;
  modeDeadBtn.classList.toggle('active', domain === 'dead');
  modeLiveBtn.classList.toggle('active', domain === 'live');
  brandSubtitle.textContent = domain === 'dead'
    ? "Dead Cattle — Guided Photo Capture"
    : "Live Cattle — Guided Photo Capture";
  state.currentStepIdx = 0;
  selectStep(0);
  updateProgress();
}
modeDeadBtn.addEventListener('click', () => switchDomain('dead'));
modeLiveBtn.addEventListener('click', () => switchDomain('live'));

function buildChips(){
  chipScroll.innerHTML = "";
  allNavSteps().forEach((s, idx) => {
    const chip = document.createElement('div');
    const done = stepIsDone(s);
    chip.className = 'chip' + (idx===state.currentStepIdx ? ' active':'') + (done ? ' done':'');
    chip.innerHTML = `<span class="dot"></span><span>${s.label}</span>`;
    chip.addEventListener('click', () => selectStep(idx));
    chipScroll.appendChild(chip);
  });
}

function buildThumbs(){
  thumbStrip.innerHTML = "";
  allNavSteps().forEach((s, idx) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (idx===state.currentStepIdx ? ' active':'');
    const cap = representativeCapture(s);
    if(cap){
      t.innerHTML = `<img src="${cap.dataUrl}"><div class="tag">${s.label}</div>`;
    } else {
      t.innerHTML = `<div class="placeholder">＋</div><div class="tag">${s.label}</div>`;
    }
    t.addEventListener('click', () => selectStep(idx));
    thumbStrip.appendChild(t);
  });
}

function updateProgress(){
  const req = requiredSteps();
  const done = req.filter(s => stepIsDone(s)).length;
  progressFill.style.width = (done/req.length*100) + "%";
  progressCount.textContent = `${done} / ${req.length}`;
  exportBtn.classList.toggle('show', done === req.length);
}

function updateSideToggleUI(step){
  if(!step.sided){ sideToggle.classList.remove('show'); return; }
  sideToggle.classList.add('show');
  const side = state.stepSide[step.id];
  sideLeftBtn.classList.toggle('active', side==='left');
  sideRightBtn.classList.toggle('active', side==='right');
}

function selectStep(idx){
  state.currentStepIdx = idx;
  const step = currentStep();

  faceBox.style.display = 'none';
  partBox.style.display = 'none';
  partBox2.style.display = 'none';
  partBox3.style.display = 'none';
  recIndicator.classList.remove('show');
  shutterBtn.classList.remove('recording');
  debugReset();
  updateSideToggleUI(step);
  updateRefButton(step);
  // Gallery upload IS allowed for Geotag steps -- lets you upload a photo
  // already stamped by a dedicated app (e.g. "GPS Map Camera"), as an
  // alternative to tapping capture to auto-generate one from the Flank photo.
  // NOT allowed for Video -- video capture is live-recording only
  // (MediaRecorder-based), with no gallery-upload equivalent. Without this
  // exclusion, someone could select a plain image file while on the Video
  // step and the app would incorrectly process it as if it were a photo
  // capture for that step.
  galleryBtn.style.display = step.video ? 'none' : 'flex';
  maskBoxKey = "";
  readyStreak = 0; isReady = false;
  guideMain.classList.remove('ready'); guideHalo.classList.remove('ready'); camHint.classList.remove('ready');

  if(!step.sided && !step.border){
    // LIVE steps with no static traced outline, plus freeform/video steps
    // (Owner Photo, Scar/Injury, Video) -- no detection UI needed.
    viewfinder.classList.remove('demo-mode');
    guideMain.setAttribute('d', '');
    guideHalo.setAttribute('d', '');
    guideLabel.textContent = step.label;
    camHintText.textContent = step.hint;
    reqNote.innerHTML = `<b>${step.label}:</b> ${step.hint}`;
  } else {
    viewfinder.classList.remove('demo-mode');
    const key = borderKeyFor(step);
    const b = BORDERS[key];
    guideMain.setAttribute('d', b ? b.path : '');
    guideHalo.setAttribute('d', b ? b.path : '');
    guideLabel.textContent = b ? b.label : step.label;
    camHintText.textContent = step.hint;
    reqNote.innerHTML = `<b>${(b?b.label:step.label)}:</b> ${step.hint}`;
  }

  const cap = state.captures[captureKey(step)];
  if(cap){ showCaptured(cap); } else { showLive(); }
  buildChips();
  buildThumbs();
}

[["left",sideLeftBtn],["right",sideRightBtn]].forEach(([side, el]) => {
  el.addEventListener('click', () => {
    const step = currentStep();
    if(!step.sided) return;
    if(state.stepSide[step.id] === side) return;
    // Dead Flank/Head keep BOTH sides' state.captures independently (the
    // side-aware captureKey above handles that automatically) -- only
    // clear the slot for other sided steps (currently just Live Flank),
    // which still use a single shared slot regardless of side.
    const keepsBothSides = isDualSideStep(step);
    state.stepSide[step.id] = side;
    if(!keepsBothSides && state.captures[captureKey(step)]) delete state.captures[captureKey(step)];
    selectStep(state.currentStepIdx);
    updateProgress();
  });
});

function mapsUrl(lat, lon){ return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`; }
function shortDevice(ua){
  let platform = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Unknown";
  let browser = /Chrome\/([\d.]+)/.test(ua) ? "Chrome " + ua.match(/Chrome\/([\d.]+)/)[1].split('.')[0]
              : /Firefox\/([\d.]+)/.test(ua) ? "Firefox " + ua.match(/Firefox\/([\d.]+)/)[1].split('.')[0]
              : /Version\/([\d.]+).*Safari/.test(ua) ? "Safari " + ua.match(/Version\/([\d.]+)/)[1].split('.')[0]
              : "Browser";
  return `${platform} · ${browser}`;
}

function showCaptured(cap){
  // Detection boxes are LIVE overlays tied to the video feed -- once a
  // static photo is captured, they'd otherwise freeze in place on top of
  // it, misleadingly implying ongoing analysis. Hide them, same as the
  // guide outline SVG already does on capture.
  partBox.style.display = 'none';
  partBox2.style.display = 'none';
  partBox3.style.display = 'none';
  faceBox.style.display = 'none';

  if(cap.isVideo){
    frameImg.style.display = 'none';
    playbackVideo.style.display = 'block';
    playbackVideo.src = cap.videoBlobUrl;
    playbackVideo.currentTime = 0;
  } else {
    playbackVideo.style.display = 'none';
    playbackVideo.removeAttribute('src');
    frameImg.style.display = 'block';
    frameImg.src = cap.dataUrl;
  }
  viewfinder.classList.add('captured');
  shutterBtn.classList.add('retake-mode');
  metaTime.textContent = "🕒 " + cap.meta.timeLabel;
  metaGps.textContent = "📍 " + cap.meta.gpsLabel;

  reqNote.style.display = 'none';
  document.getElementById('metaPanel').classList.add('show');
  document.getElementById('mpTime').textContent = cap.meta.timeLabel;
  document.getElementById('mpSide').textContent = cap.side ? (cap.side==='left' ? 'Left' : 'Right') : '—';
  document.getElementById('mpSource').textContent = sourceLabelFor(cap.meta);
  document.getElementById('mpRes').textContent = cap.meta.resolution || '—';
  document.getElementById('mpDevice').textContent = shortDevice(cap.meta.device);
  const mpGps = document.getElementById('mpGps');
  if(cap.meta.lat!=null){
    mpGps.innerHTML = `<a href="${mapsUrl(cap.meta.lat, cap.meta.lon)}" target="_blank" rel="noopener">${cap.meta.lat.toFixed(5)}, ${cap.meta.lon.toFixed(5)} ↗</a>`;
  } else {
    mpGps.textContent = cap.meta.gpsLabel || "Unavailable";
  }

  // ELA toggle -- TESTING ONLY, shown per current instructions. Only
  // relevant for gallery-uploaded photos where ELA was actually computed.
  // elaImg now overlays ON TOP of frameImg with adjustable opacity, rather
  // than replacing it, so frameImg always stays visible once a photo is
  // captured.
  elaImg.style.display = 'none';
  elaImg.style.opacity = 1;
  frameImg.style.display = cap.isVideo ? 'none' : 'block';
  elaToggleBtn.classList.remove('active');
  elaToggleBtn.textContent = "🔍 View Error Level Analysis (testing only)";
  elaControls.classList.remove('show');
  document.getElementById('metaPanel').classList.remove('ela-mode');
  currentCapForEla = null;
  if(cap.elaDataUrl){
    elaImg.src = cap.elaDataUrl;
    elaToggleBtn.style.display = 'block';
    // Reset sliders to defaults for each newly-reviewed photo.
    elaQualitySlider.value = 90;
    elaOpacitySlider.value = 95;
    elaQualityVal.textContent = "90%";
    elaOpacityVal.textContent = "95%";
    elaRegenStatus.textContent = "";
    elaToggleBtn.onclick = () => {
      const showingEla = elaToggleBtn.classList.toggle('active');
      elaImg.style.display = showingEla ? 'block' : 'none';
      if(showingEla) applyElaOpacity();   // apply whatever the opacity slider is currently set to
      elaControls.classList.toggle('show', showingEla);
      // Free up vertical space for the photo by hiding the metadata rows
      // while reviewing ELA -- not needed for this check, and competing
      // for the same limited screen space was squeezing the image down
      // to a sliver.
      document.getElementById('metaPanel').classList.toggle('ela-mode', showingEla);
      currentCapForEla = showingEla ? cap : null;
      elaToggleBtn.textContent = showingEla
        ? "🔍 Hide Error Level Analysis"
        : "🔍 View Error Level Analysis (testing only)";
    };
  } else {
    elaToggleBtn.style.display = 'none';
    elaToggleBtn.onclick = null;
  }

  // Automated tamper-check score (0-100). Runs for BOTH gallery uploads
  // and live state.captures (live capture support added at explicit request --
  // see chat: this technique detects evidence of EDITING, and a live
  // photo goes straight from camera sensor to canvas with no editing step
  // in between, so it has no real signal to work with here and should be
  // expected to reliably show "clean"/low-score regardless of anything
  // real -- kept for UI consistency, not because it's meaningful for live
  // state.captures). For anything else (freeform/video/geotag/demo steps), show
  // "Not applicable" rather than hiding the row, so it's clear the check
  // was intentionally skipped rather than silently missing.
  //
  // Shown as a SCORE with a band label, not a hard verdict -- deliberate,
  // given everything today's real testing found: this technique has real,
  // non-obvious blind spots (see the honesty note on TAMPER_CHECK_CONFIG),
  // so presenting a confident-sounding binary "clean/suspicious" would
  // overstate what this actually knows. A low score means "nothing found
  // by this check", not "verified genuine".
  const mpTamperRow = document.getElementById('mpTamperRow');
  const mpTamperBadge = document.getElementById('mpTamperBadge');
  const mpTamperDetail = document.getElementById('mpTamperDetail');
  if(!cap.isVideo && cap.meta && (cap.meta.source === 'camera' || cap.meta.source === 'gallery' || cap.meta.source === 'geotag-generated')){
    mpTamperRow.style.display = '';
    if(cap.tamperVerdict){
      const v = cap.tamperVerdict;
      const bandIcon = v.band === 'elevated' ? '⚠️' : v.band === 'uncertain' ? '❔' : '✅';
      const bandLabel = v.band === 'elevated' ? 'Elevated' : v.band === 'uncertain' ? 'Uncertain' : 'Low';
      mpTamperBadge.className = `tamper-badge ${v.band}`;
      mpTamperBadge.textContent = `${bandIcon} ${v.score}/100 — ${bandLabel} likelihood of editing`;
      mpTamperDetail.style.display = 'block';
      const effectiveSource = cap.meta.source === 'geotag-generated' ? cap.meta.originalSource : cap.meta.source;
      mpTamperDetail.textContent = (effectiveSource === 'camera')
        ? `Not meaningful for live state.captures — this check looks for signs of prior editing, which a live photo never has. Expect this to always show low/clean, regardless of anything real. Shown for consistency only.`
        : `Not a verdict — an automated estimate only. A low score means nothing suspicious was found by this check, not that the photo is confirmed genuine.`;
    } else {
      mpTamperBadge.className = 'tamper-badge na';
      mpTamperBadge.textContent = cap.tamperChecking ? '⏳ Checking…' : 'Not checked';
      mpTamperDetail.style.display = 'none';
    }
  } else {
    mpTamperRow.style.display = 'none';
    mpTamperDetail.style.display = 'none';
  }
}
function showLive(){
  viewfinder.classList.remove('captured');
  shutterBtn.classList.remove('retake-mode');
  playbackVideo.pause();
  playbackVideo.style.display = 'none';
  frameImg.style.display = 'none';
  elaImg.style.display = 'none';
  elaToggleBtn.style.display = 'none';
  elaControls.classList.remove('show');
  currentCapForEla = null;
  clearTimeout(elaRegenTimeout);
  reqNote.style.display = '';
  document.getElementById('metaPanel').classList.remove('show');
  document.getElementById('metaPanel').classList.remove('ela-mode');
}

function initGeolocation(){
  if(!("geolocation" in navigator)){
    state.locationStatus = "unsupported";
    gpsPill.textContent = "📍 GPS unavailable";
    gpsPill.className = "gps-pill error";
    return;
  }
  gpsPill.textContent = "📍 Locating…";
  gpsPill.className = "gps-pill pending";
  gpsPill.removeAttribute('href');

  // A cold GPS fix with NO network assist (offline / airplane-mode-with-
  // location-on) can genuinely take 30-60+ seconds -- far longer than a
  // normal online fix. watchPosition's own timeout below is intentionally
  // generous for that reason; this separate "stillWaiting" flag just lets
  // us show the person a more honest, distinct message if it's simply
  // slow rather than actually failed, instead of leaving them stuck on a
  // spinner or misreporting a slow fix as "denied".
  let gotFirstFix = false;
  const stillWaitingTimer = setTimeout(() => {
    if(!gotFirstFix){
      gpsPill.textContent = "📍 Still locating (offline GPS can take a minute)…";
    }
  }, 15000);

  navigator.geolocation.watchPosition(
    (pos) => {
      gotFirstFix = true;
      clearTimeout(stillWaitingTimer);
      state.lastLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      state.locationStatus = "ok";
      gpsPill.textContent = `📍 ${state.lastLocation.lat.toFixed(5)}, ${state.lastLocation.lon.toFixed(5)} ↗`;
      gpsPill.className = "gps-pill linked";
      gpsPill.href = mapsUrl(state.lastLocation.lat, state.lastLocation.lon);
    },
    (err) => {
      console.warn("Geolocation error:", err.code, err.message);
      state.locationStatus = "error";
      gpsPill.className = "gps-pill error";
      gpsPill.removeAttribute('href');
      // err.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
      // The old version showed "Location denied" for ALL three, which was
      // misleading -- a slow/offline GPS timeout is not the same problem
      // as a blocked permission, and needs a different fix from the user.
      if(err.code === 1){
        gpsPill.textContent = "📍 Location permission denied";
      } else if(err.code === 3){
        gpsPill.textContent = "📍 No GPS fix yet — tap to retry";
      } else {
        gpsPill.textContent = "📍 GPS signal unavailable";
      }
    },
    { enableHighAccuracy:true, maximumAge:10000, timeout:60000 }
  );
}

// Manual retry: tapping the pill while it's in an error state re-runs
// geolocation from scratch, useful after stepping outside for a clearer
// sky view rather than waiting for the browser's internal retry timing.
// Registered once (not inside initGeolocation) so retries don't stack
// multiple duplicate click listeners on top of each other.
gpsPill.addEventListener('click', (e) => {
  if(gpsPill.classList.contains('error')){
    e.preventDefault();
    initGeolocation();
  }
});

// =========================================================================
// EXIF GPS + capture-time parser -- for gallery-uploaded photos.
// Fixes: uploading a photo from gallery was tagging it with the device's
// CURRENT location (e.g. Delhi, if uploaded there later) instead of where
// the photo was actually taken (e.g. Mumbai). This reads GPS coordinates
// and the original capture timestamp directly out of the photo's own EXIF
// data when present, so the claim reflects where/when the photo was
// actually shot -- not where/when it happened to be uploaded.
// NOTE: many apps (WhatsApp, Instagram, etc.) genuinely strip EXIF data
// entirely when photos pass through them -- when that's happened, there is
// truly nothing left to recover, from this or any other tool (confirmed:
// ExifTool -- the real, industry-standard command-line tool -- was tested
// against the same kind of stripped photos and found nothing either).
//
// Uses exifr (https://github.com/MikeKovarik/exifr), a mature, widely used
// library, instead of a hand-written byte parser. The earlier hand-written
// version had a real, confirmed bug: it gave up immediately upon finding
// the FIRST metadata segment if that segment wasn't EXIF (e.g. an XMP
// segment written before the EXIF one), even when real EXIF/GPS data was
// still sitting later in the same file. exifr handles this and many other
// real-world file quirks correctly.
function buildMetadata(source, resolution, exifOverride){
  let timestamp, timeLabel;
  if(exifOverride && exifOverride.dateTime){
    // Gallery upload with a real capture timestamp embedded in the photo --
    // use THAT instead of "now" (now = whenever/wherever it got uploaded).
    timestamp = exifOverride.dateTime.toISOString();
    timeLabel = exifOverride.dateTime.toLocaleString() + " (from photo)";
  } else {
    const now = new Date();
    timestamp = now.toISOString();
    timeLabel = now.toLocaleString();
  }

  let gpsLabel = "Unavailable";
  let lat=null, lon=null, accuracy=null;
  // ⚠️ FIX: some Android camera apps write a GPS block with all-zero values
  // into EXIF when location was off/denied at capture time, instead of
  // omitting GPS data entirely. 0°,0° is a spot in the ocean off West
  // Africa -- essentially never a real cattle location -- so treat it the
  // same as "no GPS data", not a real coordinate.
  const hasRealGPS = exifOverride && exifOverride.gps &&
    (Math.abs(exifOverride.gps.lat) > 0.0001 || Math.abs(exifOverride.gps.lon) > 0.0001);
  if(hasRealGPS){
    // Gallery upload with real GPS embedded in the photo -- use THAT instead
    // of the device's current live location, which would otherwise show
    // wherever the phone happens to be at upload time, not where the photo
    // was actually taken.
    lat = exifOverride.gps.lat; lon = exifOverride.gps.lon; accuracy = null;
    gpsLabel = `${lat.toFixed(5)}, ${lon.toFixed(5)} (from photo, exact GPS)`;
  } else if(source === 'gallery'){
    // Gallery upload but the photo had no usable embedded GPS (common --
    // many apps like WhatsApp strip EXIF entirely, or the camera app wrote
    // a zero placeholder because location was off). Deliberately do NOT
    // fall back to the device's current location here, since that
    // reproduces the exact "wrong city" bug this was built to avoid.
    const reasonLabels = {
      "no-exif-data":      "Not available (no location data — Android's photo picker or an app like WhatsApp likely stripped it)",
      "no-gps-data":       "Not available (no location data — Android's photo picker or an app like WhatsApp likely stripped it)",
      "zero-gps":          "Not available (location was off when this photo was taken)",
      "parse-failed":      `Not available (metadata read error: ${(exifOverride && exifOverride.errorDetail) || 'unknown'})`,
      "outer-exception":   `Not available (unexpected error: ${(exifOverride && exifOverride.errorDetail) || 'unknown'})`,
      "exifr-load-failed": "Not available (metadata reader failed to load — try again with internet on)"
    };
    gpsLabel = (exifOverride && reasonLabels[exifOverride.reason]) || "Not available (photo has no location data)";
  } else if(state.lastLocation){
    lat = state.lastLocation.lat; lon = state.lastLocation.lon; accuracy = state.lastLocation.accuracy;
    gpsLabel = `${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(accuracy)}m)`;
  }
  return { timestamp, timeLabel, lat, lon, accuracy, gpsLabel, device: navigator.userAgent, resolution, source };
}

// ---------- Camera ----------
async function startCamera(){
  stopCamera();
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facingMode }, width:{ideal:1280}, height:{ideal:1706} },
      // ⚠️ FIX: default audio constraints trigger Chrome's voice-call-style
      // processing (echo cancellation/noise suppression/auto-gain), which on
      // Android switches the whole page into "in-call" audio mode -- that's
      // why the volume rocker was controlling call volume instead of media
      // volume. Disabling these keeps it on the normal media audio stream.
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    state.currentStream = stream;
    video.srcObject = stream;
    state.audioAvailable = stream.getAudioTracks().length > 0;
    camError.classList.remove('show');
  }catch(err){
    console.warn("Camera+mic request failed, retrying video-only:", err);
    // Fallback: if audio specifically caused the failure (mic permission
    // denied, no mic hardware, etc.), don't let that break the whole app --
    // photo steps still work fine without it, video just ends up silent.
    try{
      const videoOnlyStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.facingMode }, width:{ideal:1280}, height:{ideal:1706} },
        audio: false
      });
      state.currentStream = videoOnlyStream;
      video.srcObject = videoOnlyStream;
      state.audioAvailable = false;
      camError.classList.remove('show');
    }catch(err2){
      console.error("Camera error:", err2);
      camError.classList.add('show');
    }
  }
}
function stopCamera(){
  if(state.currentStream){ state.currentStream.getTracks().forEach(t=>t.stop()); state.currentStream=null; }
}

switchBtn.addEventListener('click', () => {
  state.facingMode = (state.facingMode === "environment") ? "user" : "environment";
  startCamera();
});

let isRecording = false;
let isGeneratingGeotag = false;
let mediaRecorder = null;

// =========================================================================
// GEOTAG generation -- takes the already-captured Flank photo (whichever
// side), draws it onto a canvas, and overlays a dark info panel with the
// address (via free reverse-geocoding), coordinates, and date/time --
// same visual pattern as apps like "GPS Map Camera".
// Reverse geocoding needs internet at the moment of generating; if it
// fails (poor rural connectivity, etc.) this falls back gracefully to
// just coordinates + date/time, no address line.
// =========================================================================
// Proper MM:SS formatting for the recording countdown -- the old version
// hardcoded a single-digit format ("REC 0:0X") that only worked for 0-9
// seconds; at 60 seconds that would have shown nonsense like "REC 0:060".
function formatRecCountdown(totalSeconds){
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `REC ${m}:${String(s).padStart(2, '0')}`;
}

async function startVideoRecording(step){
  if(isRecording) return;
  const stream = video.srcObject;
  if(!stream){ await showAppAlert("Camera not ready yet — try again in a moment."); return; }

  // Grab a poster frame right at the start (used as the thumbnail image,
  // same way photo steps use their captured frame).
  const posterCanvas = document.createElement('canvas');
  const vw = video.videoWidth || 720, vh = video.videoHeight || 960;
  posterCanvas.width = vw; posterCanvas.height = vh;
  posterCanvas.getContext('2d').drawImage(video, 0, 0, vw, vh);
  const posterDataUrl = posterCanvas.toDataURL('image/jpeg', 0.85);

  let mimeType = 'video/webm;codecs=vp9,opus';
  if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
  if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp9';
  if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
  if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';   // let the browser pick

  const recordedChunks = [];
  try{
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  }catch(err){
    console.error("MediaRecorder error:", err);
    await showAppAlert("Video recording isn't supported on this browser.");
    return;
  }

  mediaRecorder.ondataavailable = (e) => { if(e.data && e.data.size > 0) recordedChunks.push(e.data); };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    const blobUrl = URL.createObjectURL(blob);
    const reader = new FileReader();
    reader.onload = () => {
      const cap = {
        isVideo: true,
        dataUrl: posterDataUrl,          // poster/thumbnail image
        videoBlobUrl: blobUrl,           // for in-session playback
        videoDataUrl: reader.result,     // base64, for export
        mimeType: blob.type,
        side: null,
        meta: buildMetadata('camera', `${vw} × ${vh}`)
      };
      state.captures[captureKey(step)] = cap;
      showCaptured(cap);
      buildChips(); buildThumbs(); updateProgress();
    };
    reader.readAsDataURL(blob);

    isRecording = false;
    recIndicator.classList.remove('show');
    shutterBtn.classList.remove('recording');
  };

  mediaRecorder.start();
  isRecording = true;
  recIndicator.classList.add('show');
  shutterBtn.classList.add('recording');

  let secondsLeft = 60;
  recCountdownText.textContent = formatRecCountdown(secondsLeft);
  const countdownInterval = setInterval(() => {
    secondsLeft--;
    if(secondsLeft > 0){
      recCountdownText.textContent = formatRecCountdown(secondsLeft);
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);

  setTimeout(() => {
    if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }, 60000);
}

shutterBtn.addEventListener('click', async () => {
  if(isRecording || isGeneratingGeotag) return;
  const step = currentStep();
  const key = captureKey(step);
  if(state.captures[key]){
    if(state.captures[key].isVideo && state.captures[key].videoBlobUrl) URL.revokeObjectURL(state.captures[key].videoBlobUrl);
    delete state.captures[key];
    showLive();
    buildChips(); buildThumbs(); updateProgress();
    return;
  }
  // ⚠️ FEATURE: don't allow capture until the required part is actually
  // detected (green/ready state). camHint's 'ready' class is the single
  // source of truth used by every detection path (dedicated model, COCO
  // fallback, pixel heuristic, and the face demo), so checking it here
  // gates capture consistently across all steps.
  if(!camHint.classList.contains('ready')){
    shutterBtn.classList.add('shake');
    setTimeout(() => shutterBtn.classList.remove('shake'), 400);
    return;
  }
  if(step.video){
    startVideoRecording(step);
    return;
  }
  if(step.geotag){
    const sourceCap = findGeotagSourceCap(step);
    if(!sourceCap) return;   // shouldn't happen -- camHint gates this already
    isGeneratingGeotag = true;
    camHintText.textContent = "Generating...";
    generateGeotagImage(sourceCap.dataUrl, sourceCap.meta)
      .then((geotaggedDataUrl) => {
        const cap = {
          dataUrl: geotaggedDataUrl,
          side: sourceCap.side,
          // Carries forward the ORIGINAL Flank photo's location/time, since
          // this image documents where/when THAT photo was taken -- not
          // the separate moment this geotag overlay was generated.
          // originalSource preserves whether that underlying photo came
          // from the live camera or a gallery upload, since 'source' itself
          // gets overwritten below to mark this as a generated composite --
          // without preserving it separately, the details panel had no way
          // to tell the two apart and always displayed "Gallery Upload".
          meta: { ...sourceCap.meta, source: 'geotag-generated', originalSource: sourceCap.meta.source },
          // Same idea for the tamper-check badge -- inherit the ORIGINAL
          // Flank photo's verdict (if any was computed) rather than
          // showing "Not checked" on the geotag composite, since this
          // image documents that same underlying photo, not a new one.
          tamperVerdict: sourceCap.tamperVerdict || null,
        };
        state.captures[key] = cap;
        showCaptured(cap);
        buildChips(); buildThumbs(); updateProgress();
      })
      .catch(async (err) => {
        console.error("Geotag generation failed:", err);
        // Surface the REAL error message directly in the alert -- same
        // diagnostic approach used earlier for the EXIF parsing errors --
        // since testing on a phone means there's no easy way to check the
        // browser console otherwise.
        const detail = (err && err.message) ? err.message : String(err);
        await showAppAlert(`Couldn't generate the geotagged image: ${detail}`);
      })
      .finally(() => { isGeneratingGeotag = false; });
    return;
  }
  const canvas = document.createElement('canvas');
  const vw = video.videoWidth || 720, vh = video.videoHeight || 960;
  canvas.width = vw; canvas.height = vh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, vw, vh);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const cap = { dataUrl, side: step.sided ? state.stepSide[step.id] : null, meta: buildMetadata('camera', `${vw} × ${vh}`) };
  // Set BEFORE the first display call below so the very first render already
  // shows "Checking…" rather than a misleading "Not checked" that then
  // silently flips a moment later.
  if(!step.video && !step.geotag && !step.demo) cap.tamperChecking = true;

  // ⚡ PERFORMANCE: show the captured photo IMMEDIATELY, don't make the
  // person stare at a frozen/blank screen while ELA/Tamper Check (and, for
  // Owner Photo, the location overlay) run -- those are genuinely heavy
  // synchronous pixel-level operations (multiple full image decode/redraw
  // passes, scanning up to ~640,000 pixels each) that were previously
  // blocking the display of the photo itself, which was very likely the
  // real cause of the lag/black-screen complaints. They now run in the
  // background afterward and the panel updates in place once ready.
  state.captures[key] = cap;
  showCaptured(cap);
  buildChips(); buildThumbs(); updateProgress();

  // ELA + Tamper Check on LIVE state.captures too, at explicit request -- despite
  // the real, structural limitation discussed at length in chat: these
  // techniques exist to detect evidence of prior EDITING, and a live
  // capture goes straight from camera sensor to canvas with no editing
  // step in between, so there is nothing for either check to find here.
  // Expect this to reliably show "clean"/low-score on every live photo,
  // genuine or not -- that is not a bug, it's the honest, correct output
  // given there's no signal to detect. Kept ONLY for UI consistency
  // between live and gallery state.captures, not because it provides real
  // fraud-detection value here.
  // ELA/Tamper Check run on every real evidentiary photo step, including
  // freeform ones (Owner Photo, Scar/Injury) -- those still deserve
  // forensic scrutiny even without a body-part model to validate content
  // against. Only Video/Geotag/Demo are excluded: Video has no single-image
  // equivalent built, Geotag inherits its verdict from its source Flank
  // photo instead of computing its own, and Demo isn't a real claim photo.
  if(!step.video && !step.geotag && !step.demo){
    (async () => {
      try{
        cap.elaDataUrl = await generateELA(dataUrl);
        cap.tamperVerdict = await computeTamperVerdict(dataUrl);
      }catch(err){
        console.warn("ELA/tamper-check generation failed (live capture):", err);
      }
      cap.tamperChecking = false;
      // Only refresh the visible panel if this exact capture is still the
      // one on screen -- the person may have already retaken it, switched
      // sides, or navigated to a different step by the time this finishes.
      if(state.captures[key] === cap && currentStep() === step){ showCaptured(cap); buildThumbs(); }
    })();
  }

  // Owner Photo gets the same location/date/time overlay burned directly
  // into the image that the Geotag step produces -- applied AFTER ELA/
  // Tamper Check above, not before, so those checks analyze the actual
  // photographic content rather than the overlay panel itself. Running
  // them on the overlaid version would risk a false flag: the panel's flat
  // background and sharp text have very different image statistics than
  // the photo around it, which is exactly the kind of "block that doesn't
  // match its surroundings" the Tamper Check looks for -- the same reason
  // the Geotag step's own composite already inherits its verdict from its
  // source photo instead of re-analyzing itself. Also runs in the
  // background now, same reasoning as above -- the photo is already on
  // screen, this quietly upgrades it to the geotagged version moments later.
  if(step.id === 'owner_photo' || step.id === 'owner_photo_live'){
    (async () => {
      try{
        cap.dataUrl = await generateGeotagImage(dataUrl, cap.meta);
      }catch(err){
        console.warn("Owner Photo location overlay failed (live capture):", err);
      }
      if(state.captures[key] === cap && currentStep() === step){ showCaptured(cap); buildThumbs(); }
    })();
  }
});

galleryBtn.addEventListener('click', () => fileInput.click());

// ---------- Reference photo button + lightbox ----------
function updateRefButton(step){
  const ref = REFERENCE_PHOTOS[referenceKeyFor(step)];
  if(ref && ref.url){
    refBtn.style.display = 'flex';
    refBtnThumb.src = ref.url;
  } else {
    refBtn.style.display = 'none';   // hide until that step's photo is uploaded
  }
}
refBtn.addEventListener('click', () => {
  const step = currentStep();
  const ref = REFERENCE_PHOTOS[referenceKeyFor(step)];
  if(!ref || !ref.url) return;
  refLightboxImg.src = ref.url;
  refLightboxCaption.textContent = ref.caption || step.label;
  refLightbox.classList.add('show');
});
refLightboxClose.addEventListener('click', () => refLightbox.classList.remove('show'));
refLightbox.addEventListener('click', (e) => { if(e.target === refLightbox) refLightbox.classList.remove('show'); });

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const step = currentStep();
  const key = captureKey(step);

  // Defense-in-depth: the button itself is hidden for Video steps (see
  // selectStep), but guard here too in case it's ever reachable another
  // way -- Video is live-recording only, no gallery-upload path exists.
  if(step.video){
    fileInput.value = "";
    return;
  }

  // Now that the <input> itself has no `accept` restriction (see comment
  // on that element for why), validate the file type here in JS instead --
  // otherwise someone could technically select a non-image file.
  if(!file.type.startsWith('image/')){
    await showAppAlert("Please select an image file (JPG or PNG).");
    fileInput.value = "";
    return;
  }

  // exifr works directly on the File object -- no separate ArrayBuffer
  // read needed first (the old hand-written parser required one; exifr
  // doesn't).
  let exifData = null;
  try{
    const parsed = await parseExifGPSAndDate(file);
    if(parsed){
      exifData = { gps: parsed.gps, dateTime: parsed.dateTime, reason: parsed.reason, errorDetail: parsed.errorDetail };
    }
  }catch(err){
    // This outer catch used to swallow errors silently (console.warn only,
    // invisible on a phone with no dev console access) -- that was a real
    // diagnostic blind spot: if anything threw here rather than inside
    // parseExifGPSAndDate's own internal try/catches, it would produce the
    // old generic "photo has no location data" fallback with zero detail
    // on WHY, no matter what actually went wrong. Now it surfaces the real
    // error message the same way the inner catches already do.
    console.warn("EXIF parse failed (outer catch):", err);
    const detail = (err && err.message) ? err.message : String(err);
    exifData = { gps:null, dateTime:null, reason:"outer-exception", errorDetail: detail };
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    const imgProbe = new Image();
    imgProbe.onload = async () => {
      const cfg = CATTLE_MODEL_CONFIG[step.id];
      const needsValidation = cfg && cfg.url && !step.freeform && !step.video && !step.geotag && !step.demo;

      if(needsValidation){
        galleryBtn.disabled = true;
        camHintText.textContent = "Checking photo...";
        let result;
        try{
          result = await validateImageAgainstModel(imgProbe, step, cfg);
        }catch(err){
          console.error("Gallery upload validation error:", err);
          result = { matched:false, wrongSide:false, error:'inference-failed' };
        }
        galleryBtn.disabled = false;
        camHintText.textContent = step.hint;

        if(!result.matched){
          if(result.wrongSide){
            await showAppAlert(`This looks like the OTHER side. Please choose a photo of the ${state.stepSide[step.id]} side, or switch the side toggle.`);
          } else if(result.error){
            await showAppAlert("Couldn't check this photo right now (model failed to load or run) — try again, or use the live camera instead.");
          } else {
            await showAppAlert(`Couldn't detect the ${step.label} in this photo. Please choose a clearer photo, or use the live camera instead.`);
          }
          fileInput.value = "";
          return;   // reject -- capture slot stays empty
        }
      }

        const cap = {
          dataUrl: ev.target.result,
          side: step.sided ? state.stepSide[step.id] : null,
          meta: buildMetadata('gallery', `${imgProbe.naturalWidth} × ${imgProbe.naturalHeight}`, exifData)
        };

        // ELA only makes sense on JPEG (PNG has no lossy-compression
        // history to analyze this way). Skip for video/geotag/demo steps
        // where it's not relevant either -- but freeform steps (Owner
        // Photo, Scar/Injury) DO get checked now, same as any other real
        // evidentiary photo.
        const isJpeg = file.type === 'image/jpeg' || file.type === 'image/jpg';
        if(isJpeg && !step.video && !step.geotag && !step.demo) cap.tamperChecking = true;

        // ⚡ PERFORMANCE: show the uploaded photo IMMEDIATELY, same reasoning
        // as the live-capture path -- ELA/Tamper Check and the Owner Photo
        // overlay are heavy synchronous pixel work that shouldn't block the
        // photo itself from appearing. They now run in the background and
        // the panel updates in place once ready.
        state.captures[key] = cap;
        showCaptured(cap);
        buildChips(); buildThumbs(); updateProgress();

        if(isJpeg && !step.video && !step.geotag && !step.demo){
          (async () => {
            try{
              cap.elaDataUrl = await generateELA(ev.target.result);
              cap.tamperVerdict = await computeTamperVerdict(ev.target.result);
            }catch(err){
              console.warn("ELA/tamper-check generation failed:", err);
            }
            cap.tamperChecking = false;
            if(state.captures[key] === cap && currentStep() === step){ showCaptured(cap); buildThumbs(); }
          })();
        }

        // Owner Photo gets the same location/date/time overlay burned
        // directly into the image that the Geotag step produces -- applied
        // AFTER ELA/Tamper Check above, for the same reason as the live-
        // capture path (see that comment): analyzing the raw photo first
        // avoids a false flag from the overlay panel's very different
        // image statistics. Also backgrounded now, same as above.
        if(step.id === 'owner_photo' || step.id === 'owner_photo_live'){
          (async () => {
            try{
              cap.dataUrl = await generateGeotagImage(ev.target.result, cap.meta);
            }catch(err){
              console.warn("Owner Photo location overlay failed (gallery upload):", err);
            }
            if(state.captures[key] === cap && currentStep() === step){ showCaptured(cap); buildThumbs(); }
          })();
        }
      };
      imgProbe.src = ev.target.result;
    };
    reader.readAsDataURL(file);

  fileInput.value = "";
});


exportBtn.addEventListener('click', () => {
  const payload = {
    generatedAt: new Date().toISOString(),
    domain: state.currentDomain,
    caseDetails: (typeof window.getCaseDetails === 'function') ? window.getCaseDetails() : null,
    // Includes every step that was actually captured, not just required ones --
    // so the optional Scar/Injury photo (when taken) makes it into the package
    // instead of being silently dropped. Dead Flank/Head can have BOTH
    // sides captured independently -- include a claim entry for each side
    // that actually has a photo, not just whichever side happens to be
    // toggled right now (which is all a plain captureKey lookup would see).
    claim: activeStepList().flatMap(s => {
      const keysToCheck = isDualSideStep(s) ? sidesForDualStep(s) : [captureKey(s)];
      return keysToCheck.filter(k => state.captures[k]).map(k => {
        const c = state.captures[k];
        const base = {
          step: s.id,
          label: s.label,
          type: c.isVideo ? "video" : "photo",
          side: c.side,
          timestamp: c.meta.timestamp,
          gps: (c.meta.lat!=null) ? { lat:c.meta.lat, lon:c.meta.lon, accuracy_m:c.meta.accuracy, maps_url: mapsUrl(c.meta.lat, c.meta.lon) } : null,
          device: c.meta.device,
          source: c.meta.source,
          resolution: c.meta.resolution
        };
        if(c.isVideo){
          // poster_base64 is a still frame for quick preview without decoding
          // the whole video; video_base64 is the actual clip.
          return { ...base, poster_base64: c.dataUrl, video_base64: c.videoDataUrl, video_mime: c.mimeType };
        }
        return { ...base, image_base64: c.dataUrl, ela_base64: c.elaDataUrl || null, tamper_check: c.tamperVerdict || null };
      });
    })
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cattle_${state.currentDomain}_claim_${Date.now()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// =========================================================================
// DETECTION -- readiness heuristic (fallback), COCO pre-filter, dedicated models
// =========================================================================
const DETECT_SAMPLE_W = 60;
let detectSampleH = 80;
let guideMaskAlpha = null;
let maskBoxKey = "";
let prevInsideLuma = null;
let readyStreak = 0;
let isReady = false;
let detectTimer = null;

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently:true });
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently:true });

function currentGuidePath(){
  const step = currentStep();
  if(!step.sided && !step.border) return "";
  const key = borderKeyFor(step);
  return (BORDERS[key] && BORDERS[key].path) || "";
}

function rebuildGuideMaskIfNeeded(boxW, boxH){
  const path = currentGuidePath();
  if(!path){ guideMaskAlpha = null; return; }
  const key = state.currentStepIdx + "_" + state.currentDomain + "_" + (state.stepSide[currentStep().id]||"") + "_" + Math.round(boxW) + "x" + Math.round(boxH);
  if(key === maskBoxKey && guideMaskAlpha) return;
  maskBoxKey = key;
  detectSampleH = Math.max(20, Math.round(DETECT_SAMPLE_W * boxH / boxW));
  maskCanvas.width = DETECT_SAMPLE_W; maskCanvas.height = detectSampleH;
  detectCanvas.width = DETECT_SAMPLE_W; detectCanvas.height = detectSampleH;
  const scale = Math.min(boxW/1000, boxH/1000);
  const offX = (boxW - 1000*scale)/2;
  const offY = (boxH - 1000*scale)/2;
  maskCtx.clearRect(0,0,DETECT_SAMPLE_W,detectSampleH);
  maskCtx.save();
  maskCtx.scale(DETECT_SAMPLE_W/boxW, detectSampleH/boxH);
  maskCtx.translate(offX, offY);
  maskCtx.scale(scale, scale);
  maskCtx.fillStyle = '#fff';
  maskCtx.fill(new Path2D(path));
  maskCtx.restore();
  const data = maskCtx.getImageData(0,0,DETECT_SAMPLE_W,detectSampleH).data;
  guideMaskAlpha = new Uint8Array(DETECT_SAMPLE_W*detectSampleH);
  for(let i=0;i<guideMaskAlpha.length;i++) guideMaskAlpha[i] = data[i*4+3] > 128 ? 1 : 0;
  prevInsideLuma = null;
}

function setReadyUI(ready){
  if(ready === isReady) return;
  isReady = ready;
  guideMain.classList.toggle('ready', ready);
  guideHalo.classList.toggle('ready', ready);
  camHint.classList.toggle('ready', ready);
  camHintText.textContent = ready ? "Good framing — capture now" : currentStep().hint;
}

function analyzeFrame(){
  if(viewfinder.classList.contains('captured')) return;
  if(!video.videoWidth || !video.videoHeight) return;
  const rect = viewfinder.getBoundingClientRect();
  if(rect.width < 10 || rect.height < 10) return;
  rebuildGuideMaskIfNeeded(rect.width, rect.height);
  if(!guideMaskAlpha){ setReadyUI(false); return; }

  const vw = video.videoWidth, vh = video.videoHeight;
  const boxRatio = rect.width/rect.height, vRatio = vw/vh;
  let sx,sy,sw,sh;
  if(vRatio > boxRatio){ sh=vh; sw=vh*boxRatio; sy=0; sx=(vw-sw)/2; }
  else { sw=vw; sh=vw/boxRatio; sx=0; sy=(vh-sh)/2; }
  detectCtx.drawImage(video, sx, sy, sw, sh, 0, 0, DETECT_SAMPLE_W, detectSampleH);

  const frame = detectCtx.getImageData(0,0,DETECT_SAMPLE_W,detectSampleH).data;
  const n = DETECT_SAMPLE_W*detectSampleH;
  const insideLuma = new Float32Array(n);
  let sum=0, count=0;
  for(let i=0;i<n;i++){
    if(guideMaskAlpha[i]){
      const o = i*4;
      const luma = 0.299*frame[o] + 0.587*frame[o+1] + 0.114*frame[o+2];
      insideLuma[i] = luma;
      sum += luma; count++;
    }
  }
  if(count < 10){ setReadyUI(false); return; }
  const mean = sum/count;
  let variance = 0;
  for(let i=0;i<n;i++){ if(guideMaskAlpha[i]){ const d = insideLuma[i]-mean; variance += d*d; } }
  variance /= count;
  const stddev = Math.sqrt(variance);

  let motion = 0;
  if(prevInsideLuma){
    let diffSum=0;
    for(let i=0;i<n;i++){ if(guideMaskAlpha[i]) diffSum += Math.abs(insideLuma[i]-prevInsideLuma[i]); }
    motion = diffSum/count;
  }
  prevInsideLuma = insideLuma;

  const CONTENT_THRESHOLD = 14;
  const MOTION_THRESHOLD = 6;
  const goodContent = stddev > CONTENT_THRESHOLD;
  const steady = motion < MOTION_THRESHOLD;
  readyStreak = (goodContent && steady) ? readyStreak+1 : 0;
  setReadyUI(readyStreak >= 2);
}

function debugReset(){ /* placeholder retained for structural parity with earlier builds */ }

// ⚡ PERFORMANCE: was 280ms (~3.6 checks/sec). Bumped to 400ms (~2.5/sec) --
// still fast enough that the green "ready" state feels responsive, but
// meaningfully eases the sustained background CPU load from continuously
// running real AI inference throughout the whole live-camera session,
// which was very likely contributing to the general lag/sluggishness
// reported alongside the black-screen issue.
function startDetection(){ stopDetection(); detectTimer = setInterval(analyzeTick, 400); }
function stopDetection(){
  if(detectTimer){ clearInterval(detectTimer); detectTimer=null; }
  readyStreak = 0; isReady = false;
  guideMain.classList.remove('ready'); guideHalo.classList.remove('ready'); camHint.classList.remove('ready');
}

let tickCounter = 0;

async function analyzeTick(){
  tickCounter++;
  const step = currentStep();
  if(step.geotag){
    // Derived step -- reuses the Flank photo, no live detection needed.
    // Gate readiness on whether the source Flank photo actually exists yet.
    faceBox.style.display = 'none';
    partBox.style.display = 'none';
    partBox2.style.display = 'none';
    partBox3.style.display = 'none';
    const sourceExists = !!findGeotagSourceCap(step);
    if(sourceExists){
      camHint.classList.add('ready');
      camHintText.textContent = isGeneratingGeotag ? "Generating..." : step.hint;
    } else {
      camHint.classList.remove('ready');
      camHintText.textContent = "Complete the Flank step first, then come back here";
    }
    return;
  }
  if(step.freeform || step.video){
    // No model, no border -- e.g. Owner Photo, Scar/Injury, Video. Always
    // "ready", no detection required, user just frames/records themselves.
    faceBox.style.display = 'none';
    partBox.style.display = 'none';
    partBox2.style.display = 'none';
    partBox3.style.display = 'none';
    camHint.classList.add('ready');
    let hintMsg = step.hint;
    if(step.video && !state.audioAvailable){
      hintMsg += " ⚠️ No microphone access — this recording will be SILENT";
    }
    camHintText.textContent = isRecording ? "" : hintMsg;
    return;
  }
  const cfg = CATTLE_MODEL_CONFIG[step.id];
  if(cfg && cfg.url){
    faceBox.style.display = 'none';
    // ⚠️ FIX: the primary model MUST finish before the secondary model starts.
    // Running two onnxruntime-web sessions' .run() calls at the same time
    // under the threaded WASM backend throws "Session already started" --
    // that's the exact error you were seeing. Awaiting here serializes them.
    await analyzeCattlePartFrame(step, cfg);
    // secondary, informational-only model (e.g. horns/ear_tag shown alongside dead Head
    // orientation) -- runs less often to keep phone performance reasonable, never affects
    // the primary green "ready" state
    const secCfg = step.secondaryModel ? SECONDARY_MODEL_CONFIG[step.id] : null;
    if(secCfg && secCfg.url){
      const every = secCfg.checkEveryNTicks || 3;
      if(tickCounter % every === 0){ await analyzeSecondaryFrame(step, secCfg); }
    } else {
      partBox2.style.display = 'none';
  partBox3.style.display = 'none';
    }
    return;
  }
  partBox2.style.display = 'none';
  partBox3.style.display = 'none';
  if(!step.sided && !step.border && COCO_MODEL_CONFIG.url){
    // LIVE steps without a dedicated model yet -- fall back to general cow-presence
    faceBox.style.display = 'none';
    analyzeCocoCowFrame(step);
    return;
  }
  if((step.domain === 'dead') && COCO_MODEL_CONFIG.url && (step.id === 'flank' || step.id === 'head')){
    faceBox.style.display = 'none';
    analyzeCocoCowFrame(step);
    return;
  }
  faceBox.style.display = 'none';
  partBox.style.display = 'none';
  analyzeFrame();
}

// ---------- Real cattle-part detection (YOLOv8 ONNX models) ----------
const cattleSessions = {};
const cattleSessionLoading = {};
const cattleLoadFailedAt = {};
const MODEL_RETRY_COOLDOWN_MS = 8000;
let cattleDetectBusy = false;

async function loadCattleModel(stepId, cfg){
  if(!cfg || !cfg.url) return null;
  if(cattleSessions[stepId]) return cattleSessions[stepId];
  if(cattleSessionLoading[stepId]) return null;
  if(cattleLoadFailedAt[stepId] && (Date.now() - cattleLoadFailedAt[stepId]) < MODEL_RETRY_COOLDOWN_MS) return null;
  cattleSessionLoading[stepId] = true;
  camHintText.textContent = "Loading detection model…";
  try{
    await window.__ortReady;
    const session = await ort.InferenceSession.create(cfg.url, { executionProviders: ['wasm'] });
    cattleSessions[stepId] = session;
    cattleLoadFailedAt[stepId] = 0;
  }catch(err){
    console.error(`Failed to load cattle model for "${stepId}":`, err);
    camHintText.textContent = "Detection model failed to load — retrying shortly…";
    cattleLoadFailedAt[stepId] = Date.now();
  }
  cattleSessionLoading[stepId] = false;
  return cattleSessions[stepId] || null;
}

function letterboxImageSource(source, sw, sh, size){
  const scale = Math.min(size/sw, size/sh);
  const nw = Math.round(sw*scale), nh = Math.round(sh*scale);
  const padX = Math.floor((size-nw)/2), padY = Math.floor((size-nh)/2);
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#727272'; ctx.fillRect(0,0,size,size);
  ctx.drawImage(source, 0,0,sw,sh, padX,padY,nw,nh);
  return { canvas:c, scale, padX, padY };
}
function letterboxVideo(video, size){
  return letterboxImageSource(video, video.videoWidth, video.videoHeight, size);
}

function canvasToCHWTensor(canvas){
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imgData = ctx.getImageData(0,0,width,height).data;
  const n = width*height;
  const float32 = new Float32Array(n*3);
  for(let i=0;i<n;i++){
    float32[i]       = imgData[i*4]   / 255;
    float32[n + i]   = imgData[i*4+1] / 255;
    float32[2*n + i] = imgData[i*4+2] / 255;
  }
  return new ort.Tensor('float32', float32, [1,3,height,width]);
}

function nonMaxSuppression(boxes, scores, iouThreshold){
  const idxs = scores.map((s,i)=>i).sort((a,b)=>scores[b]-scores[a]);
  const keep = [];
  const iou = (a,b) => {
    const x1=Math.max(a[0],b[0]), y1=Math.max(a[1],b[1]);
    const x2=Math.min(a[2],b[2]), y2=Math.min(a[3],b[3]);
    const inter = Math.max(0,x2-x1)*Math.max(0,y2-y1);
    const areaA=(a[2]-a[0])*(a[3]-a[1]), areaB=(b[2]-b[0])*(b[3]-b[1]);
    return areaA+areaB-inter <= 0 ? 0 : inter/(areaA+areaB-inter);
  };
  while(idxs.length){
    const cur = idxs.shift();
    keep.push(cur);
    for(let i=idxs.length-1;i>=0;i--){
      if(iou(boxes[cur], boxes[idxs[i]]) > iouThreshold) idxs.splice(i,1);
    }
  }
  return keep;
}

function decodeYoloOutput(output, scale, padX, padY, confThreshold, targetClassId){
  const data = output.data;
  const dims = output.dims;
  const numAttrs = dims[1], numAnchors = dims[2];
  const numClasses = numAttrs - 4;
  const boxes = [], scores = [], classIds = [];
  const restrictToClass = (targetClassId !== undefined && targetClassId !== null);
  for(let i=0;i<numAnchors;i++){
    let bestScore, bestClass;
    if(restrictToClass){
      bestScore = data[(4+targetClassId)*numAnchors + i];
      bestClass = targetClassId;
    } else {
      bestScore = 0; bestClass = -1;
      for(let c=0;c<numClasses;c++){
        const s = data[(4+c)*numAnchors + i];
        if(s > bestScore){ bestScore = s; bestClass = c; }
      }
    }
    if(bestScore < confThreshold) continue;
    const cx = data[0*numAnchors+i], cy = data[1*numAnchors+i];
    const w  = data[2*numAnchors+i], h  = data[3*numAnchors+i];
    boxes.push([(cx - w/2 - padX) / scale, (cy - h/2 - padY) / scale, (cx + w/2 - padX) / scale, (cy + h/2 - padY) / scale]);
    scores.push(bestScore);
    classIds.push(bestClass);
  }
  return { boxes, scores, classIds };
}

async function analyzeCattlePartFrame(step, cfg){
  if(viewfinder.classList.contains('captured')) return;
  if(cattleDetectBusy) return;
  if(!video.videoWidth || !video.videoHeight) return;
  cattleDetectBusy = true;
  try{
    let session = cattleSessions[step.id];
    if(!session){ session = await loadCattleModel(step.id, cfg); }
    if(!session){ cattleDetectBusy = false; return; }

    const { canvas, scale, padX, padY } = letterboxVideo(video, cfg.inputSize);
    const inputTensor = canvasToCHWTensor(canvas);
    const feeds = {};
    feeds[session.inputNames[0]] = inputTensor;
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];

    const targetClassId = (cfg.onlyClassIndex !== undefined) ? cfg.onlyClassIndex : null;
    const { boxes, scores, classIds } = decodeYoloOutput(output, scale, padX, padY, cfg.confThreshold, targetClassId);
    const keep = nonMaxSuppression(boxes, scores, cfg.iouThreshold);

    // ⚠️ FIX: for sided steps (flank left/right, head left/right), only a
    // detection that matches the CURRENTLY SELECTED side toggle should count
    // as "ready". Previously any detection (whichever side the model saw)
    // was accepted, so pointing the camera at a left flank while the toggle
    // was set to "right" would incorrectly show ready/green.
    let matchIdx = null;
    let wrongSideIdx = null;
    if(step.sided){
      const wantSide = state.stepSide[step.id];   // "left" or "right"
      for(const idx of keep){
        const cname = (cfg.classNames[classIds[idx]] || "").toLowerCase();
        if(cname.includes(wantSide)){
          if(matchIdx === null || scores[idx] > scores[matchIdx]) matchIdx = idx;
        } else {
          if(wrongSideIdx === null || scores[idx] > scores[wrongSideIdx]) wrongSideIdx = idx;
        }
      }
    } else if(keep.length > 0){
      matchIdx = keep[0];
    }

    if(matchIdx !== null){
      const [x1,y1,x2,y2] = boxes[matchIdx];
      positionPartBox(x1,y1,x2,y2);
      const name = cfg.classNames[classIds[matchIdx]] || step.label;
      partBoxTag.textContent = `${name.toUpperCase()} ✓ ${(scores[matchIdx]*100).toFixed(0)}%`;
      partBox.style.display = 'block';
      camHint.classList.add('ready');
      camHintText.textContent = "Detected — capture now";
    } else if(wrongSideIdx !== null){
      // Model DID detect the animal, just the wrong side for the current
      // toggle -- give a specific, helpful hint instead of a generic
      // "not detected" message.
      partBox.style.display = 'none';
      camHint.classList.remove('ready');
      camHintText.textContent = "That looks like the other side — switch the side toggle above or reposition";
    } else {
      partBox.style.display = 'none';
      camHint.classList.remove('ready');
      camHintText.textContent = step.hint;
    }
  }catch(err){
    console.error("Cattle model inference error:", err);
  }
  cattleDetectBusy = false;
}

// =========================================================================
// GALLERY UPLOAD VALIDATION -- runs the SAME dedicated model + same-side
// matching logic used for live capture against an uploaded static image,
// so gallery uploads can no longer bypass detection entirely (previously
// ANY image was accepted regardless of content).
// Only applies to steps that actually HAVE a dedicated trained model
// (flank, head, ear_tag, flank_live, front_view_live, rear_view_live,
// ear_tag_live). Steps without one (muzzle, muzzle_live -- no trained
// model exists yet) and freeform/video/geotag/demo steps are intentionally
// left unvalidated, same as they already work in live capture.
// =========================================================================
async function validateImageAgainstModel(imgEl, step, cfg){
  let session = cattleSessions[step.id];
  if(!session) session = await loadCattleModel(step.id, cfg);
  if(!session) return { matched:false, wrongSide:false, error:'model-unavailable' };

  const { canvas, scale, padX, padY } = letterboxImageSource(imgEl, imgEl.naturalWidth, imgEl.naturalHeight, cfg.inputSize);
  const inputTensor = canvasToCHWTensor(canvas);
  const feeds = {};
  feeds[session.inputNames[0]] = inputTensor;
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];

  const targetClassId = (cfg.onlyClassIndex !== undefined) ? cfg.onlyClassIndex : null;
  const { boxes, scores, classIds } = decodeYoloOutput(output, scale, padX, padY, cfg.confThreshold, targetClassId);
  const keep = nonMaxSuppression(boxes, scores, cfg.iouThreshold);

  let matchIdx = null, wrongSideIdx = null;
  if(step.sided){
    const wantSide = state.stepSide[step.id];
    for(const idx of keep){
      const cname = (cfg.classNames[classIds[idx]] || "").toLowerCase();
      if(cname.includes(wantSide)){
        if(matchIdx === null || scores[idx] > scores[matchIdx]) matchIdx = idx;
      } else {
        if(wrongSideIdx === null || scores[idx] > scores[wrongSideIdx]) wrongSideIdx = idx;
      }
    }
  } else if(keep.length > 0){
    matchIdx = keep[0];
  }

  if(matchIdx !== null){
    return { matched:true, wrongSide:false, className: cfg.classNames[classIds[matchIdx]], score: scores[matchIdx] };
  }
  return { matched:false, wrongSide: wrongSideIdx !== null };
}

function positionPartBox(x1, y1, x2, y2){
  const rect = viewfinder.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const boxRatio = rect.width/rect.height, vRatio = vw/vh;
  let sx,sy,sw,sh;
  if(vRatio > boxRatio){ sh=vh; sw=vh*boxRatio; sy=0; sx=(vw-sw)/2; }
  else { sw=vw; sh=vw/boxRatio; sx=0; sy=(vh-sh)/2; }
  const scaleX = rect.width/sw, scaleY = rect.height/sh;
  partBox.style.left   = ((x1-sx)*scaleX) + "px";
  partBox.style.top    = ((y1-sy)*scaleY) + "px";
  partBox.style.width  = ((x2-x1)*scaleX) + "px";
  partBox.style.height = ((y2-y1)*scaleY) + "px";
}

function positionSecondaryBox(el, x1, y1, x2, y2){
  const rect = viewfinder.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const boxRatio = rect.width/rect.height, vRatio = vw/vh;
  let sx,sy,sw,sh;
  if(vRatio > boxRatio){ sh=vh; sw=vh*boxRatio; sy=0; sx=(vw-sw)/2; }
  else { sw=vw; sh=vw/boxRatio; sx=0; sy=(vh-sh)/2; }
  const scaleX = rect.width/sw, scaleY = rect.height/sh;
  el.style.left   = ((x1-sx)*scaleX) + "px";
  el.style.top    = ((y1-sy)*scaleY) + "px";
  el.style.width  = ((x2-x1)*scaleX) + "px";
  el.style.height = ((y2-y1)*scaleY) + "px";
}
// Kept for compatibility with any other caller -- delegates to the generalized version.
function positionPartBox2(x1, y1, x2, y2){ positionSecondaryBox(partBox2, x1, y1, x2, y2); }

// ---------- Secondary model (e.g. horns/ear_tag layered onto dead Head step) ----------
// Purely informational -- shown as a second, differently-colored box. Never sets the
// green "ready" state (only the primary model, e.g. head_left/head_right, controls that).
const secondarySessions = {};
const secondarySessionLoading = {};
const secondaryLoadFailedAt = {};
let secondaryDetectBusy = false;

async function loadSecondaryModel(stepId, cfg){
  if(!cfg || !cfg.url) return null;
  if(secondarySessions[stepId]) return secondarySessions[stepId];
  if(secondarySessionLoading[stepId]) return null;
  if(secondaryLoadFailedAt[stepId] && (Date.now() - secondaryLoadFailedAt[stepId]) < MODEL_RETRY_COOLDOWN_MS) return null;
  secondarySessionLoading[stepId] = true;
  try{
    await window.__ortReady;
    const session = await ort.InferenceSession.create(cfg.url, { executionProviders: ['wasm'] });
    secondarySessions[stepId] = session;
    secondaryLoadFailedAt[stepId] = 0;
  }catch(err){
    console.error(`Failed to load secondary model for "${stepId}":`, err);
    secondaryLoadFailedAt[stepId] = Date.now();
  }
  secondarySessionLoading[stepId] = false;
  return secondarySessions[stepId] || null;
}

async function analyzeSecondaryFrame(step, cfg){
  if(viewfinder.classList.contains('captured')) return;
  if(secondaryDetectBusy) return;
  if(!video.videoWidth || !video.videoHeight) return;
  secondaryDetectBusy = true;
  try{
    let session = secondarySessions[step.id];
    if(!session){ session = await loadSecondaryModel(step.id, cfg); }
    if(!session){ secondaryDetectBusy = false; return; }

    const { canvas, scale, padX, padY } = letterboxVideo(video, cfg.inputSize);
    const inputTensor = canvasToCHWTensor(canvas);
    const feeds = {};
    feeds[session.inputNames[0]] = inputTensor;
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];

    const { boxes, scores, classIds } = decodeYoloOutput(output, scale, padX, padY, cfg.confThreshold, null);
    const keep = nonMaxSuppression(boxes, scores, cfg.iouThreshold);

    // ⚠️ FIX: previously only showed the single highest-scoring detection
    // overall, so if BOTH ear_tag and horn were visible, only whichever
    // scored higher got shown -- the other was silently dropped even
    // though it was detected. Now: find the best detection for EACH
    // class separately, so both can display at the same time.
    // Class 0 (ear_tag) -> blue partBox2. Class 1 (horn) -> orange partBox3.
    let bestByClass = {};   // classId -> index into boxes/scores with highest score for that class
    for(const idx of keep){
      const cid = classIds[idx];
      if(bestByClass[cid] === undefined || scores[idx] > scores[bestByClass[cid]]) bestByClass[cid] = idx;
    }

    const eartagIdx = bestByClass[0];   // "ear_tag" is classNames[0]
    const hornIdx   = bestByClass[1];   // "horn" is classNames[1]

    if(eartagIdx !== undefined){
      const [x1,y1,x2,y2] = boxes[eartagIdx];
      positionSecondaryBox(partBox2, x1,y1,x2,y2);
      partBox2Tag.textContent = `EAR TAG ✓ ${(scores[eartagIdx]*100).toFixed(0)}%`;
      partBox2.style.display = 'block';
    } else {
      partBox2.style.display = 'none';
    }

    if(hornIdx !== undefined){
      const [x1,y1,x2,y2] = boxes[hornIdx];
      positionSecondaryBox(partBox3, x1,y1,x2,y2);
      partBox3Tag.textContent = `HORN ✓ ${(scores[hornIdx]*100).toFixed(0)}%`;
      partBox3.style.display = 'block';
    } else {
      partBox3.style.display = 'none';
    }
  }catch(err){
    console.error("Secondary model inference error:", err);
  }
  secondaryDetectBusy = false;
}

// ---------- COCO cow-presence pre-filter ----------
let cocoSession = null;
let cocoSessionLoading = false;
let cocoLoadFailedAt = 0;

async function loadCocoModel(){
  if(!COCO_MODEL_CONFIG.url || cocoSession || cocoSessionLoading) return cocoSession;
  if(cocoLoadFailedAt && (Date.now() - cocoLoadFailedAt) < MODEL_RETRY_COOLDOWN_MS) return null;
  cocoSessionLoading = true;
  camHintText.textContent = "Loading cow detector…";
  try{
    await window.__ortReady;
    cocoSession = await ort.InferenceSession.create(COCO_MODEL_CONFIG.url, { executionProviders: ['wasm'] });
    cocoLoadFailedAt = 0;
  }catch(err){
    console.error("Failed to load COCO cow-detector model:", err);
    camHintText.textContent = "Cow detector failed to load — retrying shortly…";
    cocoLoadFailedAt = Date.now();
  }
  cocoSessionLoading = false;
  return cocoSession;
}

async function analyzeCocoCowFrame(step){
  if(viewfinder.classList.contains('captured')) return;
  if(cattleDetectBusy) return;
  if(!video.videoWidth || !video.videoHeight) return;
  cattleDetectBusy = true;
  try{
    let session = cocoSession;
    if(!session){ session = await loadCocoModel(); }
    if(!session){ cattleDetectBusy = false; return; }
    const cfg = COCO_MODEL_CONFIG;
    const { canvas, scale, padX, padY } = letterboxVideo(video, cfg.inputSize);
    const inputTensor = canvasToCHWTensor(canvas);
    const feeds = {};
    feeds[session.inputNames[0]] = inputTensor;
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];
    const { boxes, scores } = decodeYoloOutput(output, scale, padX, padY, cfg.confThreshold, cfg.targetClassId);
    const keep = nonMaxSuppression(boxes, scores, cfg.iouThreshold);
    const frameArea = video.videoWidth * video.videoHeight;
    let bestIdx = -1, bestScore = 0;
    for(const idx of keep){
      const [x1,y1,x2,y2] = boxes[idx];
      const area = Math.max(0,x2-x1) * Math.max(0,y2-y1);
      if(area/frameArea >= cfg.minAreaFraction && scores[idx] > bestScore){ bestScore = scores[idx]; bestIdx = idx; }
    }
    if(bestIdx >= 0){
      const [x1,y1,x2,y2] = boxes[bestIdx];
      positionPartBox(x1,y1,x2,y2);
      partBoxTag.textContent = `COW ✓ ${(bestScore*100).toFixed(0)}%`;
      partBox.style.display = 'block';
      camHint.classList.add('ready');
      camHintText.textContent = "Cow detected — align for " + step.label.toLowerCase();
    } else {
      partBox.style.display = 'none';
      camHint.classList.remove('ready');
      camHintText.textContent = step.hint;
    }
  }catch(err){ console.error("COCO cow-detector inference error:", err); }
  cattleDetectBusy = false;
}

// ---------- Init ----------
selectStep(0);
updateProgress();
initGeolocation();
startCamera();
startDetection();
