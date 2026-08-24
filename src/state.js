// =========================================================================
// SHARED STATE -- every module that needs to read or write app-wide state
// imports this one object and uses `state.xyz`, e.g. `state.currentStepIdx`.
//
// WHY AN OBJECT, NOT SEPARATE EXPORTED VARIABLES: ES modules give you a
// live, read-only VIEW of another module's exported variables -- great for
// reading, but an importing module can't reassign an imported primitive
// directly. In the original single-file app, plain `let currentStepIdx = 0`
// style globals got reassigned everywhere (`currentStepIdx = idx`). Wrapping
// them all in one shared object sidesteps that entirely: every module
// imports the SAME object reference and can freely mutate its properties
// (`state.currentStepIdx = idx`), since that's a property write, not a
// variable reassignment.
// =========================================================================

export const state = {
  currentStepIdx: 0,
  stepSide: {},
  captures: {},          // keyed by `${domain}_${stepId}` (or `..._left`/`..._right`
                          // for Dead Flank/Head + Live Flank) so dead/live never mix
  currentDomain: "live",  // "dead" | "live" -- LIVE is the default landing tab
  currentStream: null,
  audioAvailable: false,   // whether the mic actually granted -- checked before every recording
  facingMode: "environment",
  lastLocation: null,
  locationStatus: "pending",
};
