// =========================================================================
// MODEL CONFIG -- extracted from the original index.html verbatim.
// =========================================================================
// ---- COCO general "cow present" pre-filter (works for both domains) ----
const COCO_MODEL_CONFIG = {
  url: "https://raw.githubusercontent.com/kshitij435/cattle/main/yolov8n.onnx",
  inputSize: 640,
  targetClassId: 19,
  targetClassName: "cow",
  confThreshold: 0.4,
  iouThreshold: 0.45,
  minAreaFraction: 0.12
};

// ---- Dedicated, purpose-trained models. ----
// ⚠️ PLACEHOLDER URLS: none of these 5 files are hosted yet. Upload each
// .onnx to your GitHub "cattle" repo, then paste the raw.githubusercontent.com
// link into the matching `url:` field below. Everything else is already
// configured correctly from your real training results.
const CATTLE_MODEL_CONFIG = {
  // DEAD flank -- fixes flip-bug applied, final trained result 91.7% mAP50
  flank: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/left_right_flank_dead.onnx",   // flank_best.onnx (dead)
    inputSize: 640,
    classNames: ["flank_left", "flank_right"],
    confThreshold: 0.4,
    iouThreshold: 0.45
  },
  // DEAD head/front-view -- 87.5% mAP50. Known open issue: some false positives
  // on non-head images, some left/right confusion (head_left weaker class).
  // Remember: use iou=0.3 at inference, not the default 0.45, to avoid
  // duplicate/overlapping boxes on the same head.
  head: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/head_left_right.onnx",   // head_best.onnx (dead)
    inputSize: 640,
    classNames: ["head_left", "head_right"],
    confThreshold: 0.4,
    iouThreshold: 0.3
  },
  // DEAD ear tag -- its own dedicated step now (previously only shown as a
  // secondary box during Head). Reuses the same horns+ear_tag model,
  // filtered to just the "ear_tag" class (index 0) so it gates readiness
  // on its own here, same pattern as ear_tag_live below.
  ear_tag: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/eartags_horn.onnx",
    inputSize: 640,
    classNames: ["ear_tag", "horn"],
    onlyClassIndex: 0,
    confThreshold: 0.25,
    iouThreshold: 0.45
  },
  // LIVE flank -- 94.6% mAP50, strong precision/recall balance
  flank_live: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/left_right_live.onnx",
    inputSize: 640,
    classNames: ["left side", "right side"],
    confThreshold: 0.4,
    iouThreshold: 0.45
  },
  // LIVE front head -- your strongest model, 99.0% mAP50 / 100% precision
  front_view_live: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/live_cattle_front_head.onnx",
    inputSize: 640,
    classNames: ["front_head"],
    confThreshold: 0.4,
    iouThreshold: 0.3
  },
  // LIVE rear view -- reused from the original dead-cattle rear-view model,
  // per your instruction that rear view is only needed for live, not dead.
  rear_view_live: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/best.onnx",
    inputSize: 640,
    classNames: ["cattle-rear"],
    confThreshold: 0.4,
    iouThreshold: 0.45
  },
  // LIVE ear tag -- reusing the horns+ear_tag model, filtered to just the
  // ear_tag class (class index 0 in that model's training: ['ear_tag','horn']).
  ear_tag_live: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/eartags_horn.onnx",   // horns_eartag_best.onnx
    inputSize: 640,
    classNames: ["ear_tag", "horn"],
    onlyClassIndex: 0,   // <-- restricts detection to just "ear_tag", ignores "horn" for this step
    confThreshold: 0.25,
    iouThreshold: 0.45
  }
  // DEAD muzzle has no dedicated trained model -- falls back to the pixel heuristic (see analyzeTick).
  // LIVE muzzle (muzzle_live) has no dedicated model either -- same fallback.
};

// ---- Secondary, informational-only models: run ALONGSIDE a step's primary model,
// don't affect the green "ready" state, just show an extra box for context.
// Used for: DEAD Head and LIVE Front Head both also show horn/ear_tag if visible.
const SECONDARY_MODEL_CONFIG = {
  head: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/eartags_horn.onnx",
    inputSize: 640,
    classNames: ["ear_tag", "horn"],
    confThreshold: 0.3,
    iouThreshold: 0.45,
    checkEveryNTicks: 3   // runs less often than the primary model, to keep phone performance reasonable
  },
  front_view_live: {
    url: "https://raw.githubusercontent.com/kshitij435/cattle/main/eartags_horn.onnx",
    inputSize: 640,
    classNames: ["ear_tag", "horn"],
    confThreshold: 0.3,
    iouThreshold: 0.45,
    checkEveryNTicks: 3
  }
};

export { COCO_MODEL_CONFIG, CATTLE_MODEL_CONFIG, SECONDARY_MODEL_CONFIG };
