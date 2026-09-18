# =========================================================================
# SERVER-SIDE EXIF DETECTION SIGNALS -- gallery upload analysis, ported
# from the Detection Signals sheet in the timestamp_verification_matrix.
# This runs on the SERVER, not the client -- unlike the earlier client-side
# EXIF read (which only pulled DateTimeOriginal + GPS for display), this
# can't be bypassed by disabling JS or tampering with the browser, and it's
# the authoritative version used for the actual trust signals.
#
# HONESTY NOTE (same spirit as forensics.js's tamper-check disclosure):
# this checks the signals the Matrix sheet documents, but does NOT cover
# everything on that sheet. JPEG quantization-table fingerprinting,
# XMP xmpMM:History, EXIF-thumbnail-vs-main-image timestamp comparison,
# and sun-position/luminance checks are NOT implemented here -- they need
# either raw JPEG segment parsing or reference data this project doesn't
# have yet. What IS covered: DateTimeOriginal/ModifyDate re-save check,
# GPS tag fingerprint (lat/long present but supporting tags absent),
# Software tag (editor names), Make/Model/LensModel presence, a coarse
# GPS-UTC-vs-local-time offset reconciliation, and a screenshot-dimension
# heuristic. Each flag is reported individually rather than collapsed into
# one score, so nothing here overstates its own precision.
# =========================================================================
import io
from datetime import datetime, timedelta

import piexif
from PIL import Image

TIMEZONE_MISMATCH_TOLERANCE_HOURS = 2.5  # same tolerance used in captures.py -- named here instead of hardcoded

# Filenames/tools that indicate the image passed through an editor rather
# than coming straight from a camera.
KNOWN_EDITOR_SOFTWARE = [
    "photoshop", "gimp", "snapseed", "lightroom", "picsart", "pixlr",
    "exiftool", "paint.net", "affinity", "canva", "vsco",
]

# A handful of common phone screen resolutions (portrait, width x height).
# Not exhaustive -- new devices ship constantly -- but catches the common
# case. A match here, combined with no camera tags at all, is the
# strongest signal this check can offer for "this is a screenshot."
KNOWN_SCREEN_RESOLUTIONS = {
    (1080, 1920), (1080, 2340), (1080, 2400), (1080, 2160), (1080, 2280),
    (1170, 2532), (1179, 2556), (1284, 2778), (1290, 2796), (828, 1792),
    (750, 1334), (1242, 2688), (1440, 3040), (1440, 3200), (1440, 2960),
    (720, 1600), (720, 1280), (2048, 2732), (1668, 2388), (1620, 2160),
}


def _parse_exif_datetime(s):
    """EXIF datetimes are 'YYYY:MM:DD HH:MM:SS' -- returns None if unparseable."""
    if not s:
        return None
    try:
        return datetime.strptime(s.decode() if isinstance(s, bytes) else s, "%Y:%m:%d %H:%M:%S")
    except (ValueError, AttributeError):
        return None


def _gps_to_decimal(dms, ref):
    """Converts piexif's ((num,den),(num,den),(num,den)) DMS format to decimal degrees."""
    try:
        d = dms[0][0] / dms[0][1]
        m = dms[1][0] / dms[1][1]
        s = dms[2][0] / dms[2][1]
        dec = d + m / 60 + s / 3600
        if ref in (b"S", b"W", "S", "W"):
            dec = -dec
        return dec
    except (ZeroDivisionError, IndexError, TypeError):
        return None


def _gps_datetime(gps_ifd):
    """Builds a UTC datetime from GPSDateStamp + GPSTimeStamp, or None."""
    date_stamp = gps_ifd.get(piexif.GPSIFD.GPSDateStamp)
    time_stamp = gps_ifd.get(piexif.GPSIFD.GPSTimeStamp)
    if not date_stamp or not time_stamp:
        return None
    try:
        date_str = date_stamp.decode() if isinstance(date_stamp, bytes) else date_stamp
        d = datetime.strptime(date_str, "%Y:%m:%d")
        h = time_stamp[0][0] / time_stamp[0][1]
        mi = time_stamp[1][0] / time_stamp[1][1]
        se = time_stamp[2][0] / time_stamp[2][1]
        return d + timedelta(hours=h, minutes=mi, seconds=se)
    except (ValueError, ZeroDivisionError, IndexError, TypeError):
        return None


def _check_screenshot_dimensions(image_bytes, make, model, signals):
    """Runs the screenshot-dimension heuristic. Called both on the normal
    path AND from the early-return branches below -- a screenshot with
    its EXIF fully stripped is exactly the case this check most needs to
    still catch, not skip."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        w, h = img.size
        signals["info"]["dimensions"] = f"{w}x{h}"
        dims_match_screen = (w, h) in KNOWN_SCREEN_RESOLUTIONS or (h, w) in KNOWN_SCREEN_RESOLUTIONS
        if dims_match_screen and not make and not model:
            signals["flags"].append({
                "signal": "probable_screenshot",
                "weight": "High",
                "detail": f"The image size ({w}x{h}) matches a common phone screen size, and "
                          f"there's no camera information in the photo -- consistent with a "
                          f"screenshot rather than a photo taken with a camera.",
            })
    except Exception:
        pass  # not a format Pillow can read dimensions from -- skip this check only


def analyze_gallery_exif(image_bytes, server_received_at=None, file_last_modified=None):
    """
    Returns a dict of individual detection signals for a gallery-uploaded
    image. Never raises -- any parse failure is itself reported as a
    signal (total EXIF absence is informative per the Matrix sheet's
    scenario #8), not a crash.

    server_received_at (optional): the ONE independently-known fact this
    module otherwise lacks -- when the file actually reached the server.
    Used only for the "claimed capture date can't be in the future
    relative to upload" check, the closest gallery equivalent to Clock
    Integrity's server-comparison, since it's the only piece of gallery
    timing data we're not just trusting from the file's own claims.

    file_last_modified (optional): epoch milliseconds, read from the
    browser's File object itself -- the file's OWN filesystem timestamp,
    completely separate from anything embedded IN the file as EXIF. Closes
    a real gap found in testing: the future-date check above can be waited
    out (upload later than the clock error, and the "future" discrepancy
    disappears). This signal doesn't have that weakness -- it's fixed at
    whatever moment the file was actually last written to storage,
    regardless of how long someone waits before uploading it.
    """
    signals = {
        "exif_present": False,
        "flags": [],       # list of {signal, weight, detail}
        "info": {},         # raw-ish values pulled out, for display/debugging
    }

    try:
        exif_dict = piexif.load(image_bytes)
    except Exception as e:
        signals["flags"].append({
            "signal": "exif_totally_absent",
            "weight": "High",
            "detail": f"No photo information could be read from this file at all. Consistent "
                      f"with sending through an app like WhatsApp, or the info being removed "
                      f"on purpose -- that absence itself is worth noting.",
        })
        _check_screenshot_dimensions(image_bytes, None, None, signals)
        return signals

    ifd0 = exif_dict.get("0th", {})
    exif_ifd = exif_dict.get("Exif", {})
    gps_ifd = exif_dict.get("GPS", {})

    if not ifd0 and not exif_ifd and not gps_ifd:
        signals["flags"].append({
            "signal": "exif_totally_absent",
            "weight": "High",
            "detail": "No photo information found in this file. Same as above -- worth "
                      "treating as a real signal, not just a blank result.",
        })
        _check_screenshot_dimensions(image_bytes, None, None, signals)
        return signals

    signals["exif_present"] = True

    # ---- Timestamps ----
    date_time_original = _parse_exif_datetime(exif_ifd.get(piexif.ExifIFD.DateTimeOriginal))
    modify_date = _parse_exif_datetime(ifd0.get(piexif.ImageIFD.DateTime))
    subsec_original = exif_ifd.get(piexif.ExifIFD.SubSecTimeOriginal)
    offset_time_original = exif_ifd.get(piexif.ExifIFD.OffsetTimeOriginal)

    signals["info"]["date_time_original"] = date_time_original.isoformat() if date_time_original else None
    signals["info"]["modify_date"] = modify_date.isoformat() if modify_date else None

    if not date_time_original:
        signals["flags"].append({
            "signal": "date_time_original_missing",
            "weight": "Medium",
            "detail": "This photo has no original capture date/time saved in it.",
        })

    # The one independently-verifiable timing fact available for a gallery
    # file: it cannot claim to have been taken AFTER it was actually
    # uploaded. This is the closest gallery equivalent to Clock Integrity's
    # server-comparison -- everywhere else, we're only checking the file's
    # claims against itself; this is the one spot we check against
    # something we know for certain.
    #
    # ⚠️ Correctness note: EXIF DateTimeOriginal has NO timezone info by
    # itself -- comparing it directly against our UTC server time would
    # incorrectly flag almost every photo from outside UTC (someone in
    # India would show as "5.5 hours in the future" from the offset alone,
    # every single time, regardless of anything being wrong). Only runs
    # when OffsetTimeOriginal is actually present to convert to true UTC
    # first -- skipped otherwise rather than guessing and risking a false
    # accusation.
    if date_time_original and offset_time_original:
        try:
            offset_str = offset_time_original.decode() if isinstance(offset_time_original, bytes) else offset_time_original
            sign = 1 if offset_str[0] == "+" else -1
            oh, om = offset_str[1:].split(":")
            offset_delta = timedelta(hours=sign * int(oh), minutes=sign * int(om))
            date_time_original_utc = date_time_original - offset_delta

            if server_received_at:
                future_seconds = (date_time_original_utc - server_received_at.replace(tzinfo=None)).total_seconds()
                if future_seconds > 300:  # 5-minute buffer for ordinary clock inaccuracy on the originating device
                    signals["flags"].append({
                        "signal": "capture_date_in_future",
                        "weight": "High",
                        "detail": f"This photo claims to have been taken about "
                                  f"{int(future_seconds/60)} minute(s) AFTER it was actually "
                                  f"uploaded -- which isn't possible. The saved capture date is "
                                  f"either wrong or was deliberately changed.",
                    })

            # Closes the gap found in testing: the check above can be
            # waited out by simply uploading later than the clock error.
            # This one can't -- file_last_modified is fixed the moment the
            # file was actually written to storage, unaffected by how long
            # someone sits on it before uploading.
            if file_last_modified:
                # ⚠️ Must use utcfromtimestamp, NOT fromtimestamp -- the
                # latter silently converts to the SERVER's local timezone,
                # which would corrupt this comparison depending on
                # wherever this happens to be deployed. file_last_modified
                # is a plain UTC epoch value (JavaScript's file.lastModified
                # always is), so it needs a matching UTC conversion here.
                file_modified_dt = datetime.utcfromtimestamp(file_last_modified / 1000)
                mismatch_seconds = (date_time_original_utc - file_modified_dt).total_seconds()
                if abs(mismatch_seconds) > 300:  # same 5-minute buffer, same reasoning
                    signals["flags"].append({
                        "signal": "file_timestamp_mismatch",
                        "weight": "Medium",
                        "detail": f"This photo's claimed capture time is about "
                                  f"{int(abs(mismatch_seconds)/60)} minute(s) "
                                  f"{'ahead of' if mismatch_seconds > 0 else 'behind'} "
                                  f"when the file itself was actually last saved to storage -- "
                                  f"a separate signal from the claimed date, harder to fake "
                                  f"since it isn't something a typical EXIF editor touches. "
                                  f"Medium weight since a photo that was later copied, backed "
                                  f"up, or synced can also show a gap here for innocent reasons.",
                    })
        except (ValueError, IndexError):
            pass  # malformed OffsetTimeOriginal -- skip rather than guess

    if date_time_original and modify_date:
        delta = (modify_date - date_time_original).total_seconds()
        if delta > 60:
            signals["flags"].append({
                "signal": "modify_date_after_original",
                "weight": "High",
                "detail": f"This photo was last saved/edited {int(delta)}s after it was "
                          f"originally taken -- a normal camera photo is saved at the same "
                          f"moment it's taken, so a later save time suggests it was opened "
                          f"in some other app afterward.",
            })
        elif delta < -60:
            # The gap identified specifically for detecting a faked LATER
            # capture date: if someone uses a tool that rewrites
            # DateTimeOriginal to some date in the future relative to when
            # the file was actually last saved, ModifyDate ends up sitting
            # BEFORE DateTimeOriginal -- which is backwards for a genuine
            # photo (a file can't be saved before it claims to exist).
            # Catches the "later fake date" case that modify_date_after_
            # original's one-directional check was missing.
            signals["flags"].append({
                "signal": "modify_date_before_original",
                "weight": "High",
                "detail": f"This photo's last-saved time is {int(abs(delta))}s BEFORE its "
                          f"claimed capture time -- which isn't possible for a genuine photo "
                          f"(a file can't be saved before the moment it says it was taken). "
                          f"The capture date shown may have been deliberately set to a later, "
                          f"false date.",
            })

    if not subsec_original:
        signals["flags"].append({
            "signal": "subsec_time_absent",
            "weight": "Medium",
            "detail": "Missing a fine-grained timestamp detail that most modern phone "
                      "cameras include -- a small, weak signal on its own.",
        })
    if not offset_time_original:
        signals["flags"].append({
            "signal": "offset_time_absent",
            "weight": "Low",
            "detail": "This photo doesn't record its own timezone directly, so it has to be "
                      "worked out from the GPS location instead.",
        })

    # ---- GPS ----
    lat = _gps_to_decimal(gps_ifd.get(piexif.GPSIFD.GPSLatitude), gps_ifd.get(piexif.GPSIFD.GPSLatitudeRef))
    lon = _gps_to_decimal(gps_ifd.get(piexif.GPSIFD.GPSLongitude), gps_ifd.get(piexif.GPSIFD.GPSLongitudeRef))
    has_gps = lat is not None and lon is not None
    signals["info"]["gps_lat"] = lat
    signals["info"]["gps_lon"] = lon

    if has_gps:
        has_altitude = piexif.GPSIFD.GPSAltitude in gps_ifd
        has_dop = piexif.GPSIFD.GPSDOP in gps_ifd
        has_satellites = piexif.GPSIFD.GPSSatellites in gps_ifd
        has_processing_method = piexif.GPSIFD.GPSProcessingMethod in gps_ifd

        if not (has_altitude or has_dop or has_satellites):
            signals["flags"].append({
                "signal": "gps_supporting_tags_absent",
                "weight": "High",
                "detail": "A location is saved in this photo, but none of the usual supporting "
                          "GPS details (altitude, signal quality, satellite count) are present "
                          "-- a common sign the location was typed in or added afterward, "
                          "rather than recorded live by the device.",
            })
        if not has_processing_method:
            signals["flags"].append({
                "signal": "gps_processing_method_absent",
                "weight": "Medium",
                "detail": "The photo doesn't say how its location was obtained (GPS satellite "
                          "vs. approximate network location), which a genuine live location "
                          "fix usually records.",
            })

        # Coarse offset reconciliation (Rule Engine sheet's core Gallery
        # test). CAVEAT, disclosed rather than hidden: this uses a rough
        # longitude/15 estimate of the timezone offset, not a real IANA
        # timezone lookup -- accurate to roughly ±1 hour near timezone
        # boundaries, so the flag tolerance below is deliberately wide
        # (2.5h) to avoid false positives from that approximation alone.
        # Also inherits the OEM caveat from the README: some camera
        # stacks write GPSDateStamp/GPSTimeStamp from the system clock,
        # not the satellite fix, which silently defeats this test on
        # those devices -- validate per device model before trusting it.
        gps_dt = _gps_datetime(gps_ifd)
        if gps_dt and date_time_original:
            actual_offset_hours = (date_time_original - gps_dt).total_seconds() / 3600
            expected_offset_hours = round(lon / 15 * 2) / 2  # nearest half-hour
            mismatch = abs(actual_offset_hours - expected_offset_hours)
            signals["info"]["gps_utc_time"] = gps_dt.isoformat()
            signals["info"]["actual_offset_hours"] = round(actual_offset_hours, 2)
            signals["info"]["expected_offset_hours_estimate"] = expected_offset_hours
            if mismatch > TIMEZONE_MISMATCH_TOLERANCE_HOURS:
                signals["flags"].append({
                    "signal": "gps_time_offset_mismatch",
                    "weight": "High",
                    "detail": f"The photo's saved time doesn't line up with what its own GPS "
                              f"location suggests (off by about {actual_offset_hours:.1f}h vs "
                              f"an expected ~{expected_offset_hours:.1f}h for that location -- "
                              f"a rough estimate, not exact). This can mean the device's clock "
                              f"was changed, though some phones are known to get this wrong on "
                              f"their own, so it's not conclusive by itself.",
                })
    else:
        signals["flags"].append({
            "signal": "gps_absent",
            "weight": "Low",
            "detail": "No location saved in this photo -- either location was turned off "
                      "when it was taken, or it was removed afterward.",
        })

    # ---- Device ----
    make = ifd0.get(piexif.ImageIFD.Make)
    model = ifd0.get(piexif.ImageIFD.Model)
    lens_model = exif_ifd.get(piexif.ExifIFD.LensModel)
    software = ifd0.get(piexif.ImageIFD.Software)
    maker_note = exif_ifd.get(piexif.ExifIFD.MakerNote)

    signals["info"]["make"] = make.decode(errors="replace") if isinstance(make, bytes) else make
    signals["info"]["model"] = model.decode(errors="replace") if isinstance(model, bytes) else model
    signals["info"]["software"] = software.decode(errors="replace") if isinstance(software, bytes) else software

    if not make and not model:
        signals["flags"].append({
            "signal": "device_tags_absent",
            "weight": "Medium",
            "detail": "No phone/camera information saved in this photo -- unusual for a photo "
                      "taken directly with a camera app.",
        })
    if not maker_note:
        signals["flags"].append({
            "signal": "maker_note_absent",
            "weight": "Medium",
            "detail": "Missing a technical detail that real camera photos usually carry -- "
                      "its absence can mean the photo was edited, shared through another app, "
                      "or re-saved before reaching here.",
        })
    if software:
        software_str = (software.decode(errors="replace") if isinstance(software, bytes) else software).lower()
        matched_editor = next((e for e in KNOWN_EDITOR_SOFTWARE if e in software_str), None)
        if matched_editor:
            signals["flags"].append({
                "signal": "software_tag_names_editor",
                "weight": "High",
                "detail": f"This photo shows it was opened in {matched_editor} -- direct "
                          f"evidence it was edited after being taken.",
            })
        else:
            signals["flags"].append({
                "signal": "software_tag_present",
                "weight": "Low",
                "detail": f"This photo shows it passed through an app called "
                          f"'{software_str}' -- may just be the phone's own camera app "
                          f"labeling itself, not necessarily a concern.",
            })

    # ---- Screenshot heuristic ----
    _check_screenshot_dimensions(image_bytes, make, model, signals)

    return signals
