// =========================================================================
// GEOTAG IMAGE GENERATOR -- extracted from the original index.html
// verbatim (aside from adding the export statement below).
// =========================================================================

function formatGMTOffset(date){
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs/60)).padStart(2,'0');
  const mm = String(abs%60).padStart(2,'0');
  return `GMT ${sign}${hh}:${mm}`;
}

// Moved here from app.js (see chat: a real bug where this dependency got
// missed during the modular split -- generateGeotagImage below calls
// reverseGeocode, but reverseGeocode was left behind in app.js as a
// separate, un-imported module, throwing "reverseGeocode is not defined"
// any time real GPS data was present -- exactly the report from real
// device testing). Both functions are ONLY ever used for geotag
// generation, so they belong here together, not in app.js.
function countryCodeToFlagEmoji(code){
  if(!code || code.length !== 2) return "";
  // Converts a 2-letter country code (e.g. "IN") into its flag emoji using
  // Unicode regional indicator symbols -- no image/network needed, renders
  // natively wherever emoji are supported.
  const codePoints = [...code.toUpperCase()].map(c => 0x1F1E6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

async function reverseGeocode(lat, lon){
  try{
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if(!resp.ok) return null;
    const data = await resp.json();
    if(!data.display_name) return null;

    // Build a short "City, State, Country" title separately from the full
    // address, matching the two-tier layout (bold title + smaller full
    // address) used by apps like GPS Map Camera.
    const a = data.address || {};
    const city = a.city || a.town || a.village || a.county || "";
    const title = [city, a.state, a.country].filter(Boolean).join(", ");
    const flag = countryCodeToFlagEmoji(a.country_code);

    return { title: title || data.display_name, fullAddress: data.display_name, flag };
  }catch(err){
    console.warn("Reverse geocoding failed (offline or service unavailable):", err);
    return null;
  }
}

// Same missing-import bug as reverseGeocode above -- also only ever used
// inside generateGeotagImage, moved here for the same reason.
function measureWrappedLines(ctx, text, maxWidth){
  const words = text.split(' ');
  let line = '';
  const lines = [];
  for(const word of words){
    const testLine = line + word + ' ';
    if(ctx.measureText(testLine).width > maxWidth && line !== ''){
      lines.push(line.trim());
      line = word + ' ';
    } else {
      line = testLine;
    }
  }
  if(line.trim()) lines.push(line.trim());
  return lines;
}

// Same missing-import bug as above -- also only ever used inside
// generateGeotagImage, moved here for the same reason.
function drawPinIcon(ctx, cx, cy, size){
  // Small self-drawn pin (no external image/network -- avoids the
  // canvas-tainting risk of pulling in a real map tile).
  ctx.save();
  ctx.fillStyle = '#e05252';
  ctx.beginPath();
  ctx.arc(cx, cy - size*0.15, size*0.32, 0, Math.PI*2);
  ctx.moveTo(cx, cy + size*0.42);
  ctx.lineTo(cx - size*0.24, cy - size*0.03);
  ctx.lineTo(cx + size*0.24, cy - size*0.03);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy - size*0.15, size*0.12, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

async function generateGeotagImage(sourceDataUrl, meta){
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = sourceDataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const hasGPS = meta.lat != null && meta.lon != null;
  // Core info (coordinates + date/time) never depends on the network --
  // same reliable, API-free pattern already used everywhere else in this
  // app. The full address below is a nice-to-have on top of that: if the
  // lookup fails or there's no signal, the panel still shows correctly
  // with just coordinates + date/time, nothing breaks.
  let geo = null;
  if(hasGPS) geo = await reverseGeocode(meta.lat, meta.lon);

  const dt = new Date(meta.timestamp);
  const weekday = dt.toLocaleDateString('en-GB', { weekday:'long' });
  const dmy = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
  const time12 = dt.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
  const dateTimeLine = `${weekday}, ${dmy}  ${time12}  ${formatGMTOffset(dt)}`;
  const coordsLine = hasGPS ? `Lat ${meta.lat.toFixed(6)}°   Long ${meta.lon.toFixed(6)}°` : "GPS not available";

  const scale = canvas.width / 1000;
  const padding = 28 * scale;
  const pinSize = 32 * scale;
  const pinGap = 10 * scale;

  const titleFontSize = 30 * scale;
  const addrFontSize = 19 * scale;
  const lineFontSize = 18 * scale;
  const titleLineHeight = titleFontSize * 1.3;
  const addrLineHeight = addrFontSize * 1.45;
  const lineLineHeight = lineFontSize * 1.6;

  const textLeft = padding;
  const titleFirstLineLeft = padding + pinSize + pinGap;   // room for the pin icon, first line only
  const maxTextWidth = canvas.width - padding*2;
  const maxTitleFirstLineWidth = canvas.width - titleFirstLineLeft - padding;

  // --- Measure everything FIRST using the exact fonts that will be
  // drawn, so panel height is exact and nothing overlaps. ---
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  let titleLines = [];
  if(geo){
    const titleText = geo.flag ? `${geo.flag}  ${geo.title}` : geo.title;
    // First line has less room (pin icon takes some space); wrap the
    // rest against the full width.
    const firstPass = measureWrappedLines(ctx, titleText, maxTitleFirstLineWidth);
    if(firstPass.length <= 1){
      titleLines = firstPass;
    } else {
      // Re-wrap using full width for line 2 onward for a cleaner fit.
      titleLines = [firstPass[0]];
      const rest = titleText.slice(firstPass[0].length).trim();
      if(rest) titleLines = titleLines.concat(measureWrappedLines(ctx, rest, maxTextWidth));
    }
  }

  ctx.font = `${addrFontSize}px sans-serif`;
  let addrLines = [];
  if(geo){
    addrLines = measureWrappedLines(ctx, geo.fullAddress, maxTextWidth);
  } else if(hasGPS){
    addrLines = ["Address unavailable (offline)"];
  } else {
    addrLines = ["Location unavailable for this photo"];
  }

  const contentHeight =
    (titleLines.length ? titleLines.length*titleLineHeight + 12*scale : 0) +
    addrLines.length*addrLineHeight + 14*scale +
    lineLineHeight +    // coordinates line
    lineLineHeight;     // date/time line

  const panelHeight = padding*2 + contentHeight;
  const panelTop = canvas.height - panelHeight;

  ctx.fillStyle = 'rgba(0,0,0,0.68)';
  ctx.fillRect(0, panelTop, canvas.width, panelHeight);

  ctx.textBaseline = 'top';
  let textY = panelTop + padding;

  if(titleLines.length){
    ctx.font = `bold ${titleFontSize}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(titleLines[0], titleFirstLineLeft, textY);
    drawPinIcon(ctx, textLeft + pinSize/2, textY + titleFontSize*0.55, pinSize);
    for(let i=1; i<titleLines.length; i++){
      ctx.fillText(titleLines[i], textLeft, textY + i*titleLineHeight);
    }
    textY += titleLines.length*titleLineHeight + 12*scale;
  }

  ctx.font = `${addrFontSize}px sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.90)';
  addrLines.forEach((line, i) => ctx.fillText(line, textLeft, textY + i*addrLineHeight));
  textY += addrLines.length*addrLineHeight + 14*scale;

  ctx.font = `600 ${lineFontSize}px sans-serif`;
  ctx.fillStyle = '#8cc63f';   // matches the app's accent green, ties it visually to the rest of the UI
  ctx.fillText(coordsLine, textLeft, textY);
  textY += lineLineHeight;

  ctx.font = `${lineFontSize}px sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(dateTimeLine, textLeft, textY);

  return canvas.toDataURL('image/jpeg', 0.9);
}

export { generateGeotagImage };
