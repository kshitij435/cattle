// =========================================================================
// ERROR LEVEL ANALYSIS (ELA) -- fraud-screening aid for gallery uploads.
// Re-compresses the image at a fixed JPEG quality and diffs it against the
// original; regions that were pasted/edited/smoothed didn't share the same
// original compression pass as the rest, so they light up differently.
// ⚠️ This is a VISUAL AID for human review, not a verdict. Edges and
// high-contrast boundaries naturally glow even in authentic photos; flat
// areas naturally look "clean" even in edited ones. Only meaningful on
// JPEG source images (PNG has no compression history to analyze this way).
// =========================================================================
async function generateELA(sourceDataUrl, quality = 0.9, amplify = 15, maxDim = null){
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = sourceDataUrl;
  });

  let w = img.naturalWidth, h = img.naturalHeight;
  // Downscale the working resolution when maxDim is given -- this is a
  // VISUAL AID for a human reviewer, not a pixel-perfect forensic archive,
  // so a smaller working size is plenty to spot a suspicious patch while
  // keeping the pixel-by-pixel diff loop below fast enough to feel
  // responsive (full native resolution can otherwise briefly freeze the
  // page while regenerating, which is what made the image seem to vanish
  // while dragging the sliders).
  if(maxDim && Math.max(w, h) > maxDim){
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const origCanvas = document.createElement('canvas');
  origCanvas.width = w; origCanvas.height = h;
  const origCtx = origCanvas.getContext('2d');
  origCtx.drawImage(img, 0, 0, w, h);
  const origData = origCtx.getImageData(0, 0, w, h).data;

  // Re-compress at the fixed quality level -- this recompression IS the
  // technique: it establishes a known, uniform "compression pass" to
  // compare the original against.
  const recompressedDataUrl = origCanvas.toDataURL('image/jpeg', quality);
  const recompImg = new Image();
  await new Promise((resolve, reject) => {
    recompImg.onload = resolve;
    recompImg.onerror = reject;
    recompImg.src = recompressedDataUrl;
  });
  const recompCanvas = document.createElement('canvas');
  recompCanvas.width = w; recompCanvas.height = h;
  const recompCtx = recompCanvas.getContext('2d');
  recompCtx.drawImage(recompImg, 0, 0);
  const recompData = recompCtx.getImageData(0, 0, w, h).data;

  // Build the difference map, amplified so subtle differences become
  // visible to the eye.
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w; outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d');
  const outImageData = outCtx.createImageData(w, h);
  const outData = outImageData.data;

  for(let i = 0; i < origData.length; i += 4){
    const dr = Math.abs(origData[i]   - recompData[i]);
    const dg = Math.abs(origData[i+1] - recompData[i+1]);
    const db = Math.abs(origData[i+2] - recompData[i+2]);
    outData[i]   = Math.min(255, dr * amplify);
    outData[i+1] = Math.min(255, dg * amplify);
    outData[i+2] = Math.min(255, db * amplify);
    outData[i+3] = 255;
  }
  outCtx.putImageData(outImageData, 0, 0);

  return outCanvas.toDataURL('image/jpeg', 0.92);
}

// =========================================================================
// AUTOMATED TAMPER CHECK -- gallery uploads only. See extensive discussion
// in chat: this is deliberately NOT run on live camera captures, since a
// fresh camera photo has been JPEG-compressed exactly once and therefore
// has no "inconsistent compression history" for this technique to find --
// running it there would always report "clean" regardless of anything
// real, which is worse than no signal at all.
//
// HOW THIS WORKS: same recompression-diff pass as generateELA, but instead
// of producing a heatmap for a human to look at, it summarizes the result
// into a verdict. A genuine, untouched photo's compression error is fairly
// EVEN across the image (some areas naturally noisier than others based on
// detail/contrast, but no single patch wildly out of step with its
// neighbors). A spliced-in/edited region typically has a DIFFERENT
// compression history than the rest of the photo, so it shows up as a
// patch that's a statistical outlier relative to the image's other
// patches -- that's what this measures: split the image into a grid, find
// the most anomalous single block relative to the rest, and flag it if
// that anomaly is both statistically unusual (z-score) AND large in
// absolute terms (so a nearly-blank, low-noise photo doesn't get flagged
// over trivial relative differences).
//
// ⚠️ HONESTY NOTE (read before trusting this in production): the
// underlying z-score threshold and score curve below started as blind
// guesses and were revised against real test photos (a known-edited
// marketing graphic, a known-genuine cattle photo, and a known-edited
// wound photo that this technique could NOT detect -- see chat history).
// This is still only a handful of real data points -- test against more
// known-edited and known-genuine photos before treating the score as
// precisely calibrated. Its real, disclosed purpose is to communicate
// genuine uncertainty honestly (a fuzzy 0-100 estimate) rather than
// asserting false confidence with a hard green/red line, given how much
// today's testing showed this technique has real, non-obvious blind spots
// (e.g. it cannot see anything in a well-blended edit saved once at high
// JPEG quality -- a low score there means "nothing found", NOT "verified
// genuine").
const TAMPER_CHECK_CONFIG = {
  maxDim: 800,        // working resolution -- plenty for this, keeps it fast
  quality: 0.9,        // recompression quality used to generate the diff
  gridSize: 10,         // splits the image into a 10x10 grid of blocks
  scoreMidpointZ: 3.2,     // z-score mapped to the middle of the 0-100 score range
  scoreCurveScale: 0.5,     // how steeply the score rises around the midpoint
  minAbsoluteDiff: 2.5,      // below this, the score gets pulled toward neutral (50) -- low absolute signal means low confidence either way
};

async function computeTamperVerdict(sourceDataUrl){
  const cfg = TAMPER_CHECK_CONFIG;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = sourceDataUrl;
  });

  let w = img.naturalWidth, h = img.naturalHeight;
  if(Math.max(w, h) > cfg.maxDim){
    const scale = cfg.maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const origCanvas = document.createElement('canvas');
  origCanvas.width = w; origCanvas.height = h;
  const origCtx = origCanvas.getContext('2d');
  origCtx.drawImage(img, 0, 0, w, h);
  const origData = origCtx.getImageData(0, 0, w, h).data;

  const recompressedDataUrl = origCanvas.toDataURL('image/jpeg', cfg.quality);
  const recompImg = new Image();
  await new Promise((resolve, reject) => {
    recompImg.onload = resolve;
    recompImg.onerror = reject;
    recompImg.src = recompressedDataUrl;
  });
  const recompCanvas = document.createElement('canvas');
  recompCanvas.width = w; recompCanvas.height = h;
  const recompCtx = recompCanvas.getContext('2d');
  recompCtx.drawImage(recompImg, 0, 0);
  const recompData = recompCtx.getImageData(0, 0, w, h).data;

  // --- Bucket every pixel's diff magnitude into its grid block ---
  const gridSize = cfg.gridSize;
  const blockSums = new Float64Array(gridSize * gridSize);
  const blockCounts = new Int32Array(gridSize * gridSize);
  const blockW = w / gridSize, blockH = h / gridSize;

  for(let y = 0; y < h; y++){
    const by = Math.min(gridSize - 1, Math.floor(y / blockH));
    for(let x = 0; x < w; x++){
      const bx = Math.min(gridSize - 1, Math.floor(x / blockW));
      const idx = (y * w + x) * 4;
      const dr = Math.abs(origData[idx]   - recompData[idx]);
      const dg = Math.abs(origData[idx+1] - recompData[idx+1]);
      const db = Math.abs(origData[idx+2] - recompData[idx+2]);
      const diff = (dr + dg + db) / 3;
      const bi = by * gridSize + bx;
      blockSums[bi] += diff;
      blockCounts[bi] += 1;
    }
  }

  const blockMeans = [];
  for(let i = 0; i < blockSums.length; i++){
    blockMeans.push(blockCounts[i] ? blockSums[i] / blockCounts[i] : 0);
  }

  const overallMean = blockMeans.reduce((a,b) => a+b, 0) / blockMeans.length;
  const variance = blockMeans.reduce((a,b) => a + (b-overallMean)**2, 0) / blockMeans.length;
  const stdDev = Math.sqrt(variance);

  const maxBlockMean = Math.max(...blockMeans);
  const zScore = stdDev > 0.0001 ? (maxBlockMean - overallMean) / stdDev : 0;

  // Map the z-score onto a 0-100 curve via a sigmoid centered on
  // scoreMidpointZ, so scores climb smoothly instead of snapping between
  // two fixed labels. Calibrated against real results: a known-genuine
  // photo (z=2.38) lands around 16; a known-edited photo (z=4.13) lands
  // around 86.
  const rawScore = 100 / (1 + Math.exp(-(zScore - cfg.scoreMidpointZ) / cfg.scoreCurveScale));

  // Low absolute signal (near-blank/flat photo) means low CONFIDENCE in
  // either direction -- pull the score toward neutral (50) proportionally,
  // rather than letting a tiny, meaningless relative blip produce a
  // falsely extreme score.
  const confidence = Math.min(1, maxBlockMean / cfg.minAbsoluteDiff);
  const score = 50 + confidence * (rawScore - 50);

  let band;
  if(score < 35) band = 'low';
  else if(score < 65) band = 'uncertain';
  else band = 'elevated';

  return {
    score: Math.round(score),
    band,
    zScore: Math.round(zScore * 100) / 100,
    maxBlockMean: Math.round(maxBlockMean * 100) / 100,
    overallMean: Math.round(overallMean * 100) / 100,
  };
}

export { generateELA, computeTamperVerdict };
