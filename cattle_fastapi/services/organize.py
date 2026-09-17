# =========================================================================
# Two things live here together, on purpose:
#   1. compute_capture_flags -- the same Clock Integrity / Duplicate Check /
#      etc. computation used everywhere else in the backend. Moved here
#      (out of api/captures.py) specifically so organize_case below can use
#      it without a circular import (captures.py needs organize_case,
#      organize_case needs compute_capture_flags -- this module sits
#      "underneath" both, importing from neither).
#   2. organize_case -- copies a case's photos/videos into a clean,
#      sensibly-named folder alongside a readable summary. Called
#      automatically after every upload (see api/captures.py), so
#      organized_exports/ stays live and current with zero manual steps --
#      no terminal command needed, same as how uploads/ itself just fills
#      in automatically as people use the app.
# =========================================================================
import json
import os
import re
import shutil
from datetime import datetime
from zoneinfo import ZoneInfo

from services.db import get_conn

UPLOADS_DIR = "uploads"
OUTPUT_DIR = "organized_exports"

CLOCK_DRIFT_THRESHOLD_MS = 120_000
CAPTURE_UPLOAD_GAP_THRESHOLD_MS = 72 * 60 * 60 * 1000
ANCHOR_NTP_DRIFT_THRESHOLD_MS = 120_000


def _format_ist(timestamp_str):
    """
    Converts a stored UTC timestamp (device_timestamp/server_received_at,
    both ISO 8601, either with a 'Z' suffix or a '+00:00' offset) to IST
    for the readable case_summary.txt -- found necessary after a real
    report looked "wrong" at a glance: the underlying UTC value was
    actually correct (07:20 UTC matched a photo taken at 12:50pm IST
    exactly), but showing raw UTC without conversion meant anyone reading
    the report had to manually add 5:30 themselves to make sense of it.
    Falls back to the original raw string, unlabeled, if parsing fails
    for any reason -- a malformed timestamp shouldn't break the whole
    report, and showing the raw value as-is is more honest than hiding
    or guessing at a bad input.
    """
    if not timestamp_str:
        return timestamp_str
    try:
        normalized = timestamp_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        ist = dt.astimezone(ZoneInfo("Asia/Kolkata"))
        return ist.strftime("%Y-%m-%d %I:%M:%S %p IST")
    except (ValueError, TypeError):
        return timestamp_str


def compute_capture_flags(row: dict, conn) -> dict:
    device_time_source = row.get("device_time_source")
    device_ntp_drift_ms = row.get("device_ntp_drift_ms")
    device_clock_changed = row.get("device_clock_changed")
    drift_ms = row.get("drift_server_vs_device_ms")
    server_frame_hash = row.get("server_frame_hash")

    duplicate_of = None
    if server_frame_hash:
        duplicate_row = conn.execute(
            "SELECT id, case_id, step_id, source, server_received_at FROM captures "
            "WHERE server_frame_hash = ? AND id != ? LIMIT 1",
            (server_frame_hash, row.get("id")),
        ).fetchone()
        duplicate_of = dict(duplicate_row) if duplicate_row else None

    exif_signals = json.loads(row["exif_signals"]) if row.get("exif_signals") else None
    ocr_signals = json.loads(row["ocr_signals"]) if row.get("ocr_signals") else None
    frame_hash_match = row.get("frame_hash_match")
    timezone_mismatch_flag = row.get("timezone_mismatch_flag")

    return {
        "clock_tamper_flag": bool(device_clock_changed),
        "date_changed": bool(row.get("device_date_changed")),
        "date_wrong_at_anchor": bool(row.get("device_date_wrong_at_anchor")),
        "unanchored_flag": (device_time_source == "device-fallback"),
        "anchor_drift_flag": (
            device_ntp_drift_ms is not None
            and abs(device_ntp_drift_ms) > ANCHOR_NTP_DRIFT_THRESHOLD_MS
        ),
        "clock_drift_flag": (
            drift_ms is not None
            and CLOCK_DRIFT_THRESHOLD_MS < abs(drift_ms) <= CAPTURE_UPLOAD_GAP_THRESHOLD_MS
        ),
        "capture_upload_gap_flag": (
            drift_ms is not None and abs(drift_ms) > CAPTURE_UPLOAD_GAP_THRESHOLD_MS
        ),
        "exif_signals": exif_signals,
        "ocr_signals": ocr_signals,  # NEW -- ear tag OCR (services/eartag_ocr_service.py), None for every non-ear_tag step
        "server_frame_hash": server_frame_hash,
        "frame_hash_match": None if frame_hash_match is None else bool(frame_hash_match),
        "timezone_mismatch_flag": None if timezone_mismatch_flag is None else bool(timezone_mismatch_flag),
        "duplicate_image_flag": duplicate_of is not None,
        "duplicate_of": duplicate_of,
    }


def _safe_name(s):
    if not s:
        return "unknown"
    return re.sub(r"[^\w\-]", "_", str(s))[:60]


def organize_case(case_id, conn=None):
    """
    Rebuilds organized_exports/<case_id>_<farmer_name>/ from scratch for
    this one case -- safe to call repeatedly (e.g. once per upload), each
    call just overwrites that case's folder with the current, complete
    picture rather than appending/duplicating anything.
    """
    owns_conn = conn is None
    if owns_conn:
        conn = get_conn()
    try:
        case_row = conn.execute("SELECT * FROM cases WHERE id = ?", (case_id,)).fetchone()
        if not case_row:
            return None
        case_row = dict(case_row)

        case_dir = os.path.join(OUTPUT_DIR, f"{case_id}_{_safe_name(case_row.get('farmer_name'))}")
        # ⚠️ FIX, found via real testing: this folder name includes
        # farmer_name for readability, but farmer_name can genuinely
        # CHANGE over a case's life -- starts empty (captures happen
        # before Case Details are ever filled in) and gets filled in
        # later, or vice versa. Since this only computed a FRESH path
        # each call, a case that started as "..._unknown" and later had
        # its farmer name saved as "Leo" got a SECOND, separate
        # "..._Leo" folder created alongside the original -- two folders,
        # two case_summary.txt files, for one real case. This looks for
        # any folder ALREADY starting with this exact case_id (regardless
        # of what name suffix it currently has) and renames it in place
        # to the new path instead of creating a second one -- exactly one
        # folder per case, always, no matter when details get filled in
        # relative to captures.
        if os.path.isdir(OUTPUT_DIR):
            for existing_name in os.listdir(OUTPUT_DIR):
                if existing_name == os.path.basename(case_dir):
                    continue  # already the current, correct name
                if existing_name == case_id or existing_name.startswith(f"{case_id}_"):
                    existing_path = os.path.join(OUTPUT_DIR, existing_name)
                    if os.path.isdir(existing_path):
                        os.makedirs(OUTPUT_DIR, exist_ok=True)
                        if os.path.isdir(case_dir):
                            shutil.rmtree(case_dir)  # about to be fully rebuilt below anyway -- avoid a merge/conflict on rename
                        os.rename(existing_path, case_dir)
                    break
        os.makedirs(case_dir, exist_ok=True)

        captures = conn.execute(
            "SELECT * FROM captures WHERE case_id = ? ORDER BY id", (case_id,)
        ).fetchall()

        summary = {"case": case_row, "captures": []}
        used_names = {}

        for cap_row in captures:
            cap_dict = dict(cap_row)
            cap_dict["computed_flags"] = compute_capture_flags(cap_dict, conn)

            src_path = os.path.join(UPLOADS_DIR, cap_dict["filename"])
            ext = os.path.splitext(cap_dict["filename"])[1] or ".jpg"
            base_name = _safe_name(cap_dict["step_id"])
            count = used_names.get(base_name, 0)
            used_names[base_name] = count + 1
            dest_name = f"{base_name}{'' if count == 0 else f'_{count + 1}'}{ext}"
            dest_path = os.path.join(case_dir, dest_name)

            if os.path.exists(src_path):
                shutil.copy2(src_path, dest_path)
                cap_dict["organized_filename"] = dest_name
            else:
                cap_dict["organized_filename"] = None
                cap_dict["_warning"] = "original file missing from uploads/ folder"

            summary["captures"].append(cap_dict)

        with open(os.path.join(case_dir, "case_summary.json"), "w") as f:
            json.dump(summary, f, indent=2, default=str)

        _write_readable_summary(case_dir, case_row, summary["captures"])
        return case_dir
    finally:
        if owns_conn:
            conn.close()


def _clock_integrity_summary(flags, cap):
    """
    Mirrors the EXACT same priority order used on the webpage itself
    (renderBackendIntegrityFields in static/index.html) -- kept as its
    own function specifically so the two can be compared/kept in sync by
    eye if either ever changes. Only meaningful for camera/geotag
    captures, same as the webpage's own rule.
    """
    if cap.get("source") not in ("camera", "geotag-generated"):
        return "N/A (gallery upload)"
    if flags["unanchored_flag"]:
        return "No server time reference available"
    if flags["clock_tamper_flag"]:
        return "Date changed since anchor" if flags["date_changed"] else "Clock changed since anchor"
    if flags["anchor_drift_flag"]:
        return "Date was wrong at session start" if flags["date_wrong_at_anchor"] else "Clock was wrong at session start"
    if flags["capture_upload_gap_flag"]:
        drift_ms = cap.get("drift_server_vs_device_ms")
        hours = abs(drift_ms) / 3600000 if drift_ms is not None else 0
        return f"Long capture-to-upload gap ({hours:.0f}h)"
    if flags["clock_drift_flag"]:
        drift_ms = cap.get("drift_server_vs_device_ms")
        seconds = abs(drift_ms) / 1000 if drift_ms is not None else 0
        return f"{seconds:.0f}s drift"
    if flags["timezone_mismatch_flag"]:
        return "Timezone doesn't match location"
    return "Consistent"


def _write_readable_summary(case_dir, case_row, captures):
    lines = [
        f"CASE SUMMARY -- {case_row['id']}",
        "=" * 60,
        f"Farmer:  {case_row.get('farmer_name') or '(not filled in)'}",
        f"Village: {case_row.get('village') or '(not filled in)'}",
        f"Domain:  {case_row.get('domain')}",
        f"Created: {_format_ist(case_row.get('updated_at') or case_row.get('created_at'))}",
        "",
    ]
    for cap in captures:
        flags = cap["computed_flags"]
        lines.append(f"--- {cap['step_id']}  ({cap['organized_filename'] or 'MISSING FILE'}) ---")
        lines.append(f"  Source:          {cap['source']}")
        lines.append(f"  Captured:        {_format_ist(cap.get('device_timestamp')) or '(no device timestamp)'}")
        lines.append(f"  Server received: {_format_ist(cap['server_received_at'])}")
        if cap.get("lat") is not None and cap.get("lon") is not None:
            lines.append(f"  Location:        {cap['lat']}, {cap['lon']}  (https://www.google.com/maps/search/?api=1&query={cap['lat']},{cap['lon']})")
        else:
            lines.append(f"  Location:        Not available")
        lines.append(f"  Resolution:      {cap.get('resolution') or '(not recorded)'}")
        lines.append(f"  Device:          {cap.get('device_info') or '(not recorded)'}")
        lines.append(f"  Clock Integrity: {_clock_integrity_summary(flags, cap)}")
        if cap.get("tamper_check_score") is not None:
            lines.append(f"  Tamper Check:    {cap['tamper_check_score']}/100 -- {cap.get('tamper_check_band', '')}")
        else:
            lines.append(f"  Tamper Check:    (not computed -- video, or check hadn't finished when this was generated)")
        lines.append(f"  Frame Integrity: {'Verified untouched' if flags['frame_hash_match'] else ('MISMATCH' if flags['frame_hash_match'] is False else 'Not checked')}")
        lines.append(f"  Duplicate Check: {'SEEN BEFORE' if flags['duplicate_image_flag'] else 'Not seen before'}")
        if cap.get("normalize_scale_applied") is not None:
            if cap.get("normalize_skipped"):
                lines.append(f"  Pixel Norm.:     Skipped ({cap.get('normalize_skip_reason')})")
            else:
                lines.append(f"  Pixel Norm.:     {cap.get('normalize_scale_applied')}x applied (infra only, no consumer yet)")
        if flags.get("ocr_signals"):    # NEW -- only present for ear_tag/ear_tag_live captures
            ocr = flags["ocr_signals"]
            if ocr.get("error"):
                lines.append(f"  Ear Tag OCR:     FAILED -- {ocr['error']}")
            else:
                conf_pct = round((ocr.get("confidence") or 0) * 100)
                lines.append(f"  Ear Tag OCR:     {ocr.get('combined_text') or '(no digits read)'}  ({conf_pct}% confidence{', NEEDS REVIEW' if ocr.get('needs_review') else ''})")
                if ocr.get("letter_lines"):  # NEW -- was a single "letter_code" best guess; now every distinct letter fragment found, as-is
                    review_note = ', uncertain' if ocr.get('letters_need_review') else ''
                    lines.append(f"  Ear Tag Letters: {', '.join(ocr['letter_lines'])}{review_note}")

        warnings = []
        if flags["clock_tamper_flag"]:
            warnings.append("CLOCK CHANGED MID-SESSION")
        if flags["anchor_drift_flag"]:
            warnings.append("CLOCK WRONG AT SESSION START")
        if flags["unanchored_flag"]:
            warnings.append("NO SERVER TIME REFERENCE")
        if flags["timezone_mismatch_flag"]:
            warnings.append("TIMEZONE DOESN'T MATCH LOCATION")
        if flags["frame_hash_match"] is False:
            warnings.append("FRAME HASH MISMATCH (ALTERED IN TRANSIT)")
        if flags["duplicate_image_flag"]:
            dup = flags["duplicate_of"]
            warnings.append(f"DUPLICATE of case {dup['case_id']} / {dup['step_id']}" if dup else "DUPLICATE")
        if flags["exif_signals"] and flags["exif_signals"].get("flags"):
            high = [f for f in flags["exif_signals"]["flags"] if f["weight"] == "High"]
            if high:
                warnings.append(f"{len(high)} HIGH-WEIGHT EXIF FLAG(S)")
        if flags.get("ocr_signals") and flags["ocr_signals"].get("needs_review"):
            warnings.append("EAR TAG OCR NEEDS REVIEW (low confidence or unexpected format)")

        lines.append(f"  Warnings:        {', '.join(warnings) if warnings else 'None'}")
        lines.append("")

    with open(os.path.join(case_dir, "case_summary.txt"), "w") as f:
        f.write("\n".join(lines))
