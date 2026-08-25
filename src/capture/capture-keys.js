// =========================================================================
// CAPTURE KEY HELPERS -- extracted from the original index.html, adapted
// to read/write the shared `state` object instead of bare module-level
// variables. Logic is otherwise unchanged from the original.
// =========================================================================
import { state } from '../state.js';
import { DEAD_STEPS, LIVE_STEPS } from '../config/steps.js';

export function activeStepList(){ return state.currentDomain === "dead" ? DEAD_STEPS : LIVE_STEPS; }
export function allNavSteps(){ return activeStepList(); }
export function requiredSteps(){ return activeStepList().filter(s => s.required); }
export function currentStep(){ return allNavSteps()[state.currentStepIdx]; }

export function referenceKeyFor(step){ return step.sided ? `${step.id}_${state.stepSide[step.id]}` : step.id; }
export function borderKeyFor(step){ return step.sided ? step.variants[state.stepSide[step.id]] : step.border; }

// Turns a capture's meta.source into the label shown in the details panel.
// Handles all three cases the app can actually produce: a raw live-camera
// shot, a raw gallery upload, and a Geotag step's generated composite
// (which isn't "from" either directly -- it's built FROM one of the two,
// so it shows that original source in parentheses rather than mislabeling
// itself as a plain gallery upload, which was the previous bug here).
export function sourceLabelFor(meta){
  if(meta.source === 'geotag-generated'){
    const origLabel = meta.originalSource === 'camera' ? 'Live Camera' : 'Gallery Upload';
    return `Geotag Overlay (from ${origLabel})`;
  }
  return meta.source === 'camera' ? 'Live Camera' : 'Gallery Upload';
}

// Dead Flank and Head deliberately store BOTH sides independently (see
// chat) -- switching the Left/Right toggle no longer discards whichever
// side was already captured, letting a person capture both if they want.
// Every OTHER sided step (currently just Live Flank) keeps the original
// single-slot-per-step behavior, where switching sides discards whatever
// was there before.
export function isDualSideStep(step){ return step.id === "flank" || step.id === "head" || step.id === "flank_live"; }
export function sidesForDualStep(step){ return [step.domain+"_"+step.id+"_left", step.domain+"_"+step.id+"_right"]; }

export function captureKey(step){
  if(isDualSideStep(step)) return step.domain + "_" + step.id + "_" + state.stepSide[step.id];
  return step.domain + "_" + step.id;
}
// "Done" for a dual-side step means EITHER side has a capture, not
// specifically whichever side happens to be toggled right now.
export function stepIsDone(step){
  if(isDualSideStep(step)) return sidesForDualStep(step).some(k => !!state.captures[k]);
  return !!state.captures[captureKey(step)];
}
// For thumbnails: prefer whatever the currently-toggled side has, but fall
// back to the OTHER side if that's the one actually captured -- so the
// thumbnail doesn't look empty just because the toggle happens to be on
// the side that wasn't captured.
export function representativeCapture(step){
  if(isDualSideStep(step)){
    const current = state.captures[captureKey(step)];
    if(current) return current;
    const [leftKey, rightKey] = sidesForDualStep(step);
    return state.captures[leftKey] || state.captures[rightKey] || null;
  }
  return state.captures[captureKey(step)] || null;
}

// Geotag pulls its source photo from Flank (dead: "flank", live: "flank_live"
// via step.geotagSource) -- now that Flank stores Left/Right independently,
// there's no single non-side-specific key to look up anymore. Geotag
// doesn't care WHICH side, just that ONE exists -- so check both and use
// whichever is actually there (preferring Left if somehow both exist,
// though which one wins doesn't matter for this purpose).
export function findGeotagSourceCap(step){
  const leftKey  = step.domain + "_" + step.geotagSource + "_left";
  const rightKey = step.domain + "_" + step.geotagSource + "_right";
  return state.captures[leftKey] || state.captures[rightKey] || null;
}
