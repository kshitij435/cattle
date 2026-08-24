// =========================================================================
// EXIF GPS + capture-time parser -- for gallery-uploaded photos.
//
// ADAPTED FROM THE ORIGINAL: the original loaded exifr from a CDN
// <script> tag at runtime (window.__exifrReady / global `exifr`), which
// needed a safety-timeout race in case the script never loaded. With a
// proper npm import, Vite bundles exifr directly into the build -- there's
// no async script-loading race to guard against anymore, so that part of
// the original function has been simplified out. The actual EXIF-parsing
// logic itself (the `pick`-filter bug fix, the zero-GPS guard, the error-
// detail surfacing) is unchanged from the original, verbatim.
//
// Fixes: uploading a photo from gallery was tagging it with the device's
// CURRENT location (e.g. Delhi, if uploaded there later) instead of where
// the photo was actually taken (e.g. Mumbai). This reads GPS coordinates
// and the original capture timestamp directly out of the photo's own EXIF
// data when present, so the claim reflects where/when the photo was
// actually shot -- not where/when it happened to be uploaded.
// NOTE: many apps (WhatsApp, Instagram, Android's Photo Picker, etc.) can
// strip EXIF/GPS data entirely -- when that's happened, there is truly
// nothing left to recover, from this or any other tool (confirmed against
// the real ExifTool utility on the same stripped photos -- see project
// history). This is a genuine Android platform limitation
// (ACCESS_MEDIA_LOCATION is a native-app-only permission), not a bug here.
// =========================================================================
import exifr from 'exifr';

export async function parseExifGPSAndDate(file){
  let output;
  try{
    // NOTE: deliberately no `pick` filter here. An earlier version of this
    // restricted `pick` to ['DateTimeOriginal', 'CreateDate', 'latitude',
    // 'longitude'] -- but `pick` filters RAW EXIF tag names, and
    // 'latitude'/'longitude' aren't raw tags; they're DERIVED fields exifr
    // computes from the real raw tags (GPSLatitude, GPSLatitudeRef, etc.)
    // AFTER parsing. That meant the GPS block matched nothing and was
    // silently dropped every time -- confirmed with a real GPS-tagged test
    // photo: the restricted version returned the date correctly but always
    // returned undefined for latitude/longitude, no error thrown. Letting
    // gps/exif parse fully (unrestricted) is what actually works.
    output = await exifr.parse(file, { gps: true, exif: true });
  }catch(err){
    console.warn("exifr parse failed:", err);
    // Surface the REAL error message in the returned reason (rather than
    // just a generic "parse-failed" label) so it's actually visible to the
    // person testing on a real phone with no dev console access -- lets us
    // see exactly what's going wrong instead of guessing blind.
    const detail = (err && err.message) ? err.message : String(err);
    return { gps:null, dateTime:null, reason:"parse-failed", errorDetail: detail };
  }

  if(!output){
    return { gps:null, dateTime:null, reason:"no-exif-data" };
  }

  let gps = null, reason = "no-gps-data";
  if(typeof output.latitude === 'number' && typeof output.longitude === 'number'){
    // Some cameras write a placeholder 0,0 when location was off at
    // capture time -- same defensive check the old parser had.
    if(Math.abs(output.latitude) < 0.0001 && Math.abs(output.longitude) < 0.0001){
      reason = "zero-gps";
    } else {
      gps = { lat: output.latitude, lon: output.longitude };
      reason = "ok";
    }
  }

  // exifr already revives EXIF dates into real Date objects -- no need for
  // the old separate parseExifDateString() string-parsing step.
  const dateTime = (output.DateTimeOriginal instanceof Date) ? output.DateTimeOriginal
                  : (output.CreateDate instanceof Date) ? output.CreateDate
                  : null;

  return { gps, dateTime, reason };
}
