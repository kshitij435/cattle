# =========================================================================
# SERVER-SIDE EAR TAG OCR -- reads the tag number off the ear_tag /
# ear_tag_live capture, same "runs on the server, not the client" spirit
# as exif_service.py. The client-side YOLO model (eartags_horn.onnx) only
# GATES the capture -- confirms an ear tag is visible and centered before
# letting the person move on. It does not read the digits. This is the
# piece that actually reads them, and it has to run server-side: nothing
# about tag-number extraction can be trusted if computed in a browser the
# claimant controls.
#
# ⚠️ DESIGN NOTE, changed after real testing: earlier versions validated
# digit lines against a strict "exactly 6 digits" rule and required
# exactly 2 lines per tag, assuming every tag shared the MLDB/AH/MH
# reference format (header line, barcode, two 6-digit lines). Real data
# proved that wrong -- a Bajaj Allianz-issued tag uses a completely
# different, legitimate layout (a short code, company name, a SINGLE
# digit line), and got a correct 100%-confidence reading wrongly flagged
# because it didn't fit the assumed shape. Rather than keep chasing
# per-issuer format rules, this module now reports whatever OCR actually
# detects -- digits and letters, deduplicated, in reading order -- with
# NO format or line-count validation. needs_review is purely a
# confidence signal (OCR's own uncertainty about what it read), not a
# structural judgment about what a "correct" tag should look like.
#
# HONESTY NOTE: the barcode is not decoded here -- this reads the printed
# digits only. A barcode scanner (pyzbar) could cross-check the printed
# number against the barcode payload as a second independent signal --
# this was built and tested at one point (real, checksum-verified
# decodes), then deliberately removed at the project owner's request, as
# barcode matching wasn't needed for this use case.
# =========================================================================
import io
import json
import re
import logging

import numpy as np
import cv2

logger = logging.getLogger(__name__)

# Below this confidence, flag for manual review. Applied to the WEAKEST
# individual line, not an average across lines -- see needs_review's
# computation further down for why.
CONFIDENCE_REVIEW_THRESHOLD = 0.75

# ⚠️ FIX, found via real testing: this used to be defined LOCALLY inside
# analyze_eartag_ocr, invisible to _try_orientations/_score above it.
# That let the rotation-sweep's scoring function reward a candidate with
# two tiny matching-length garbage fragments (e.g. "12"/"34") purely for
# LOOKING structurally clean (same length, count of 2) -- then the
# downstream filter (which correctly drops anything under this length as
# noise) removed them anyway, leaving a confidently-selected candidate
# that evaporated to nothing. Moved to module level and applied INSIDE
# _run_at now, so scoring and final filtering always agree on what
# counts as a real fragment in the first place.
MIN_FRAGMENT_LEN = 3

# Crops smaller than this on the short side get upscaled before OCR --
# PaddleOCR's recognition accuracy falls off sharply below ~32px
# character height, and ear tag crops from the YOLO detector are often
# small relative to the full frame (see NORMALIZE_CONFIG's comment in
# static/index.html re: ear_tag_live's naturally-small target size).
MIN_SHORT_SIDE_PX = 200

# NEW -- performance fix, found via real testing: full-resolution phone
# photos (2618x1965 seen in practice) made fastNlMeansDenoisingColored
# below genuinely slow -- its cost grows with pixel count, and combined
# with two full OCR passes (see _try_orientations), organized_exports
# updates were lagging a couple of MINUTES behind the actual upload.
# OCR doesn't need full camera resolution -- capping the long edge here
# cuts denoising and inference time substantially with little to no
# accuracy loss, since text recognition operates at a modest working
# resolution internally regardless of input size.
MAX_LONG_SIDE_PX = 700   # ⚠️ REDUCED from 1000 after a real crash: a full, wide,
                          # uncropped field photo (legs + background + a date/
                          # location watermark) crashed PaddleX's OWN inference
                          # engine with "RuntimeError: Unknown exception" -- deep
                          # inside compiled code (self.predictor.run()), not
                          # anything in this file. The same photo, manually
                          # cropped tighter first, worked fine -- likely some
                          # unusual-aspect-ratio/size combination this specific
                          # PaddleX build can't handle, similar in kind to the
                          # PP-OCRv5 "strides" engine crash hit earlier. Can't
                          # fix the engine itself, so keeping images smaller
                          # before they ever reach it is the mitigation.

_ocr_singleton = None  # lazy-loaded, see get_ocr_engine() below


def _reset_ocr_engine():
    """
    Forces the singleton to reload on next use. Called after a real
    engine-level crash (see _run_at's except block below) -- if PaddleX's
    OWN inference engine genuinely crashed once, there's a real risk it
    left internal state corrupted, and since this engine instance is
    reused across EVERY request (that's the whole point of the
    singleton, avoiding reload cost per capture), a corrupted instance
    would silently break every SUBSEQUENT request too, not just the one
    that crashed -- previously-good images could start reading as
    "nothing detected" for no reason related to those images at all.
    Found via real testing: images that read correctly earlier started
    failing after a genuine crash happened in between. Discarding the
    singleton after a crash and letting it reload fresh trades a one-time
    reload cost (same as a cold start) for not silently running every
    later capture through a potentially-broken engine instance.
    """
    global _ocr_singleton
    _ocr_singleton = None


def get_ocr_engine():
    """
    Loads PaddleOCR once and caches it at module level. PaddleOCR
    initialization loads several ONNX/Paddle models from disk (or
    downloads them on first-ever run) -- expensive enough that doing it
    per-request would add real latency to every ear tag upload. Call this
    once eagerly at app startup (see main.py's @app.on_event("startup"))
    so the first real upload isn't the one that pays the load cost.
    """
    global _ocr_singleton
    if _ocr_singleton is None:
        from paddleocr import PaddleOCR
        _ocr_singleton = PaddleOCR(
            lang="en",
            ocr_version="PP-OCRv4",              # NEW -- PP-OCRv5 (this lib's default) hits a known
                                                   # PaddlePaddle 3.0.0 PIR-executor bug on some Windows/CPU
                                                   # setups: "ValueError: (InvalidArgument) Type of
                                                   # attribute: strides is not right." PP-OCRv4 uses the
                                                   # older, stable inference path and sidesteps it entirely.
                                                   # See github.com/PaddlePaddle/PaddleOCR/issues/15908
            use_doc_orientation_classify=False,  # ear tags aren't full documents
            use_doc_unwarping=False,
            use_textline_orientation=True,       # tags are rarely perfectly frontal
            # ⚠️ TESTED AND REVERTED: tried lowering text_det_thresh/
            # text_det_box_thresh below their PP-OCRv4 defaults to try to
            # recover a tag's top digit line that the detector wasn't
            # proposing at all (confirmed missing via debug_raw_lines --
            # not even a garbled attempt, nothing). Made things WORSE on
            # real testing: the top line still wasn't detected, AND the
            # previously-clean bottom-line reading got noisier (95% ->
            # 77% confidence, and a genuine digit misread, 317716 read as
            # 317916). Loosening detection sensitivity let noise into the
            # recognition stage without recovering the line it was meant
            # to help. Documented here as a dead end so it isn't tried
            # again blind -- the real fix for a compressed/distorted line
            # like this is capture angle (shoot straighter-on), not a
            # detector threshold.
        )
    return _ocr_singleton


def _preprocess(img: np.ndarray) -> np.ndarray:
    """
    Light preprocessing tuned for the yellow-tag/black-digit look of the
    reference photo, shot outdoors under variable natural light:
      - downscale large captures so preprocessing/inference cost stays bounded
      - upscale small crops so digit height clears MIN_SHORT_SIDE_PX
      - CLAHE contrast enhancement (harsh sun / shadow on the tag)
      - mild denoise for JPEG compression artifacts from phone uploads
    """
    h, w = img.shape[:2]
    long_side = max(h, w)
    if long_side > MAX_LONG_SIDE_PX:
        scale = MAX_LONG_SIDE_PX / long_side
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]

    short_side = min(h, w)
    if short_side < MIN_SHORT_SIDE_PX:
        scale = MIN_SHORT_SIDE_PX / short_side
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge((l, a, b))
    img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    img = cv2.fastNlMeansDenoisingColored(img, None, 3, 3, 7, 21)

    # NEW -- padding border, added after real testing showed a leading
    # digit sitting right at the tag/frame edge with almost no margin
    # around it (visually confirmed by cropping in close on the actual
    # failing photo -- a genuinely blurry top line AND that character
    # positioned right at the boundary, not just tilted). Text detectors
    # generally need some surrounding context to confidently draw a box
    # around a character -- one with nothing but frame edge on one side
    # is a known, real failure mode, distinct from the tilt problem the
    # rotation sweep already addresses. A uniform border gives every
    # character in the image the same margin the ones in the middle
    # already had, regardless of where on the tag it happens to sit.
    # ⚠️ FOLLOW-UP, found via real testing: 40px recovered a previously-
    # dropped LEADING digit on one tag, but the same photo then dropped
    # a TRAILING digit instead ("101616" -> "10161") -- real evidence the
    # mechanism is right (edge margin matters) but 40px wasn't quite
    # enough on that side. Increased to 60px.
    PAD_PX = 60
    img = cv2.copyMakeBorder(img, PAD_PX, PAD_PX, PAD_PX, PAD_PX, cv2.BORDER_CONSTANT, value=(255, 255, 255))

    return img


def _try_orientations(engine, img: np.ndarray):
    """
    Runs OCR at 0° first; only tries 180° if 0° wasn't already confident.
    Added after testing against real field photos -- unlike the
    reference tag (shot frontally), real captures can have the tag
    genuinely upside-down in frame (camera orientation, how the person's
    hand was holding the ear). use_textline_orientation above handles
    PER-LINE rotation within a correctly-oriented crop, but a crop that's
    upside-down as a WHOLE is a different failure mode -- this is the
    cheap, explicit fix for that rather than trusting the line-level
    classifier to also cover it.

    ⚠️ PERFORMANCE FIX, found via real testing: this used to ALWAYS run
    both passes -- fine for accuracy, but it doubles inference cost on
    every single capture, even the common case where the tag was already
    right-side-up. Combined with large images (see MAX_LONG_SIDE_PX
    above), that pushed organized_exports updates a couple of MINUTES
    behind the actual upload. Now the 180° pass only runs when 0°'s
    result didn't already clear CONFIDENCE_REVIEW_THRESHOLD -- the
    common case (right-side-up tag) now costs one pass, not two.

    Extracts BOTH the digit content and any letter content from each
    detected text region (e.g. tags print a letter code like "JKTGVY"
    above the digit lines -- previously discarded entirely, since only
    digits were kept). "Best" orientation is still chosen by digit-line
    confidence, since the tag NUMBER is the primary signal this module
    is for -- the letter code just rides along from whichever
    orientation that turned out to be.
    """
    def _run_at(angle):
        # ⚠️ FIX, found via real testing: PaddleX's own inference engine
        # can crash outright on certain inputs (a real "RuntimeError:
        # Unknown exception" traced to deep inside its compiled
        # text-detection predictor -- not anything in this file, and not
        # something a size cap alone reliably prevents, confirmed by
        # testing). Both real crashes seen so far were on notably tilted
        # tags -- exactly the kind that triggers the multi-angle sweep
        # below, meaning ONE bad angle out of up to 10+ tried per image
        # could kill the entire analysis, discarding a perfectly good
        # result already found at an earlier angle. Wrapping each
        # individual angle attempt means a crash on any ONE angle is
        # treated as "found nothing at this angle" and the sweep moves
        # on, instead of the whole capture failing outright.
        try:
            return _run_at_unsafe(angle)
        except Exception:
            logger.exception(f"OCR engine crashed at rotation angle {angle} -- resetting engine and skipping this angle")
            # NEW -- see _reset_ocr_engine's comment: don't keep reusing
            # an engine instance that just crashed. This request still
            # uses the (possibly-still-bad) `engine` variable already
            # captured in this closure for any REMAINING angles in this
            # same sweep, but the NEXT request will get a fresh instance
            # via get_ocr_engine() rather than inheriting this one.
            _reset_ocr_engine()
            return (0.0, [], [], [], [], None, img)

    def _run_at_unsafe(angle):
        if angle == 0:
            candidate = img
        elif angle == 180:
            candidate = cv2.rotate(img, cv2.ROTATE_180)
        else:
            # General rotation, needed for the deskew sweep below --
            # cv2.rotate only handles exact 90°/180°/270°.
            h, w = img.shape[:2]
            M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
            candidate = cv2.warpAffine(img, M, (w, h), borderValue=(255, 255, 255))
        result = engine.predict(candidate)
        digit_lines, digit_scores, digit_ys = [], [], []
        letter_lines, letter_scores = [], []
        for page in result:
            texts = page.get("rec_texts", [])
            page_scores = page.get("rec_scores", [])
            boxes = page.get("rec_boxes", [])
            for i, text in enumerate(texts):
                score = float(page_scores[i]) if i < len(page_scores) else 0.0
                # ⚠️ FIX, found via real testing against a two-line tag:
                # PaddleOCR does NOT guarantee top-to-bottom detection
                # order -- got "158128370023" for a tag that reads
                # "370023" / "158128" top-to-bottom, because the bottom
                # line happened to be detected first. box[1] is the top-
                # edge y-coordinate; sorting digit lines by this below
                # restores actual reading order regardless of detection
                # order. This was flagged as a known gap in an earlier
                # version of this function's comments but never actually
                # implemented until now.
                y = float(boxes[i][1]) if i < len(boxes) and len(boxes[i]) >= 2 else i
                digits = re.sub(r"[^0-9]", "", text)
                letters = re.sub(r"[^A-Za-z]", "", text).upper()
                # ⚠️ FIX: MIN_FRAGMENT_LEN applied HERE now, not just
                # later in analyze_eartag_ocr -- see MIN_FRAGMENT_LEN's
                # own comment for why a mismatch here caused a real bug.
                if digits and len(digits) >= MIN_FRAGMENT_LEN:
                    digit_lines.append(digits)
                    digit_scores.append(score)
                    digit_ys.append(y)
                if letters and len(letters) >= MIN_FRAGMENT_LEN:
                    letter_lines.append(letters)
                    letter_scores.append(score)
        # Sort digit lines top-to-bottom by box position -- detection
        # order alone doesn't reflect reading order (see fix note above).
        if digit_lines:
            order = sorted(range(len(digit_lines)), key=lambda idx: digit_ys[idx])
            digit_lines = [digit_lines[idx] for idx in order]
            digit_scores = [digit_scores[idx] for idx in order]
        mean_conf = (sum(digit_scores) / len(digit_scores)) if digit_scores else 0.0
        # NEW -- topmost digit line's y-coordinate and the candidate image
        # itself, both needed by the letter-region close-up pass below.
        top_digit_y = min(digit_ys) if digit_ys else None
        return (mean_conf, digit_lines, digit_scores, letter_lines, letter_scores, top_digit_y, candidate)

    def _score(candidate):
        # Combined scoring for picking the best rotation candidate --
        # digit line count matters most (a real tag's number is the
        # primary signal), but WITHIN equally-good digit results, prefer
        # whichever angle also read any letter content more confidently.
        # ⚠️ FIX, found via real testing: the old logic only ever accepted
        # a new candidate if it found exactly 2 digit lines -- for a
        # genuinely single-line tag (a Bajaj Allianz tag, "23 C" + a
        # stylized company logo + one digit line), that condition can
        # NEVER be satisfied, so EVERY angle tried in the sweep below got
        # silently discarded even if one of them read the letter/logo
        # content far better than angle 0 did. This scoring function lets
        # a genuinely better letter reading actually win, instead of
        # requiring an impossible digit-line count first.
        _, d_lines, d_scores, l_lines, l_scores, _top_y, _img = candidate
        digit_conf = (sum(d_scores) / len(d_scores)) if d_scores else 0.0
        letter_conf = (sum(l_scores) / len(l_scores)) if l_scores else 0.0
        line_count_bonus = 1.0 if len(d_lines) == 2 else 0.0
        # NEW -- reward candidates whose digit lines are the SAME length
        # as each other, added after real testing showed a dropped-digit
        # misread ("101616" -> "01616") sitting at high confidence next
        # to a correct 6-digit line, and needed a reason to lose to a
        # candidate (if any angle produces one) where both lines actually
        # match. Relative, not a fixed target length -- doesn't
        # reintroduce the per-issuer format-guessing problem from before.
        length_consistency_bonus = 0.0
        if len(d_lines) >= 2:
            length_consistency_bonus = 1.0 if len({len(l) for l in d_lines}) == 1 else 0.0
        return (line_count_bonus * 10) + (length_consistency_bonus * 5) + digit_conf + (letter_conf * 0.5)

    best = _run_at(0)
    if best[0] < CONFIDENCE_REVIEW_THRESHOLD:
        candidate_180 = _run_at(180)
        if candidate_180[0] > best[0]:
            best = candidate_180

    # NEW -- deskew sweep, triggered by DIGIT quality issues: missing
    # lines, low confidence, OR (added after real testing) digit lines
    # that are inconsistent lengths WITH EACH OTHER -- e.g. "01616" next
    # to "751920", where a dropped leading digit slipped through at high
    # individual confidence and the sweep never used to even run, since
    # confidence and line-count both looked fine on their own. Letters
    # stay a secondary beneficiary of whatever search already happens
    # for digit reasons, not a trigger of their own -- deliberately NOT
    # triggering this on weak letter confidence alone: letters are often
    # stylized/logo text that may never clear CONFIDENCE_REVIEW_THRESHOLD
    # no matter the angle (see the note on _score above), so gating the
    # expensive multi-angle search on letter quality would fire on
    # nearly every capture and reintroduce the per-capture slowdown
    # fixed earlier -- for a field you've said is lower priority than
    # the tag number itself. Motivated by real evidence: the same
    # rotation-correction trick recovered a BARCODE decode on a tilted
    # tag (services/eartag_barcode_service.py, -20° fixed it) --
    # extended here so that whenever this search DOES run for digit
    # reasons, a better letter reading can also win via _score above.
    lines_inconsistent = len(best[1]) >= 2 and len({len(l) for l in best[1]}) > 1
    if len(best[1]) != 2 or best[0] < CONFIDENCE_REVIEW_THRESHOLD or lines_inconsistent:
        best_score = _score(best)
        for angle in (-10, 10, -20, 20, -15, 15, -25, 25, -30, 30):
            candidate = _run_at(angle)
            candidate_score = _score(candidate)
            if candidate_score > best_score:
                best = candidate
                best_score = candidate_score

    return best  # (mean_conf, digit_lines, digit_scores, letter_lines, letter_scores, top_digit_y, candidate_img)


def analyze_eartag_ocr(image_bytes: bytes) -> dict:
    """
    Runs OCR on an ear tag capture and returns a dict matching the same
    "signals object" shape as exif_service.analyze_gallery_exif -- meant
    to be JSON-serialized straight into the captures.ocr_signals column
    and echoed back in the upload response, same pattern as exif_signals.

    Returns:
        {
            "ocr_attempted": True,
            "combined_text": "370023158128",   # all detected digit-lines concatenated, as read
            "lines": ["370023", "158128"],     # individual detected digit lines, top-to-bottom, deduplicated
            "letter_lines": ["MLDBAHMH"],       # any letter-only text found (e.g. a tag's header/company
                                                 # code), deduplicated, as-is -- empty list if none found
            "confidence": 0.94,                # mean confidence across detected DIGIT lines
            "needs_review": False,              # purely a confidence signal now -- see note below
            "error": None,
        }

    ⚠️ Deliberately does NOT validate format or line count -- see the
    inline comment where digit_lines/letter_lines get built for why:
    real tags come from multiple issuers with different layouts (some
    two 6-digit lines, some a single line, different letter-code
    lengths), and every attempt to encode "the" tag format as a rule
    ended up wrongly rejecting or flagging a real, differently-formatted
    tag. This reports whatever OCR actually found, deduplicated only.

    Never raises -- an OCR failure is reported as a signal (needs_review
    True, error set), same as exif_service's analysis_error handling,
    since a broken OCR call should never be able to block the upload
    itself.
    """
    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Could not decode image bytes")

        img = _preprocess(img)

        engine = get_ocr_engine()
        mean_conf, raw_lines, scores, letter_lines, letter_scores, top_digit_y, winning_img = _try_orientations(engine, img)

        # ⚠️ SIMPLIFIED per direct request: previously required digit
        # lines to match TAG_LINE_REGEX (exactly 6 digits) and letter
        # fragments to match LETTER_CODE_REGEX (3-10 letters) before
        # keeping them -- built assuming all tags share one format. Real
        # testing proved that wrong more than once: a dropped-digit
        # misread ("101616" -> "01616") needed the length check to catch
        # it, but the SAME kind of check also wrongly rejected/flagged
        # legitimate different-format tags (a Bajaj Allianz tag's single
        # 6-digit line got flagged for an unrelated line-count reason
        # built on the same "one true format" assumption). Rather than
        # keep patching format assumptions that keep not holding across
        # real tag issuers, this now reports whatever OCR actually
        # detected -- digits and letters, deduplicated, in top-to-bottom
        # reading order -- with NO target-length or line-count assumption.
        #
        # One narrow exception, added back after real testing showed pure
        # noise (a stray "8", single-digit barcode-region artifacts)
        # leaking into combined_text: fragments of 1-2 characters are
        # dropped as noise. This is NOT a "tags are N digits" assumption
        # -- it's just "a single stray character is essentially never
        # genuine tag content, regardless of which issuer's format it
        # is" -- so it doesn't reintroduce the overfitting problem above.
        # (MIN_FRAGMENT_LEN is now also applied earlier, inside
        # _try_orientations/_run_at -- this pass is just the dedup step.)
        digit_lines, digit_scores, seen_digits = [], [], set()
        for line, score in zip(raw_lines, scores):
            if len(line) < MIN_FRAGMENT_LEN or line in seen_digits:
                continue
            seen_digits.add(line)
            digit_lines.append(line)
            digit_scores.append(score)

        letter_lines_deduped, letter_scores_deduped, seen_letters = [], [], set()
        for line, score in zip(letter_lines, letter_scores):
            if len(line) < MIN_FRAGMENT_LEN or line in seen_letters:
                continue
            seen_letters.add(line)
            letter_lines_deduped.append(line)
            letter_scores_deduped.append(score)

        # NEW -- letter close-up pass, tried ONLY when the letter reading
        # so far looks uncertain (or nothing was found at all). Real
        # idea, not a repeat of the digit-side fixes: letters/logos sit
        # in a small region of the whole photo, and even after the
        # whole-image upscale in _preprocess, that region can still be
        # tiny in absolute pixels -- the same problem digit accuracy had
        # before normalization, just not addressed for letters yet.
        # Every real tag examined puts letter/header content ABOVE the
        # topmost digit line, so crop to that band specifically and
        # upscale it hard on its own, then re-run OCR on just that crop.
        # Only digit lines' own y-coordinate is used for this, not any
        # letter-format assumption, so it doesn't reintroduce the
        # per-issuer format-guessing problem from before.
        letter_min_conf_so_far = min(letter_scores_deduped) if letter_scores_deduped else 0.0
        needs_letter_closeup = (not letter_lines_deduped) or (letter_min_conf_so_far < CONFIDENCE_REVIEW_THRESHOLD)
        # ⚠️ FIX: wrapped in its own try/except, same reasoning as the
        # rotation sweep's per-angle wrapping above -- this is a SEPARATE
        # engine.predict() call, outside the sweep, that could ALSO hit
        # the same real PaddleX engine crash. Before this fix, a crash
        # here took down the ENTIRE result (a perfectly good digit
        # reading included) just because the secondary letter-improvement
        # attempt failed. Now it's skipped gracefully, keeping whatever
        # digit/letter result was already found.
        try:
            if needs_letter_closeup and top_digit_y is not None and top_digit_y > 20:
                h, w = winning_img.shape[:2]
                crop_bottom = int(top_digit_y)
                crop_top = max(0, crop_bottom - int(crop_bottom * 1.2) - 20)  # generous margin above the digit line
                letter_crop = winning_img[crop_top:crop_bottom, 0:w]
                if letter_crop.size > 0:
                    ch, cw = letter_crop.shape[:2]
                    # Upscale the crop specifically so it clears a much larger
                    # target than the whole-image MIN_SHORT_SIDE_PX does --
                    # this small region needs to be much bigger on its own to
                    # give small stylized text a real chance.
                    target_short_side = 300
                    short_side = min(ch, cw)
                    if short_side > 0 and short_side < target_short_side:
                        scale = target_short_side / short_side
                        letter_crop = cv2.resize(letter_crop, (int(cw * scale), int(ch * scale)), interpolation=cv2.INTER_CUBIC)
                    closeup_result = engine.predict(letter_crop)
                    closeup_letters, closeup_scores = [], []
                    for page in closeup_result:
                        texts = page.get("rec_texts", [])
                        page_scores = page.get("rec_scores", [])
                        for i, text in enumerate(texts):
                            letters_only = re.sub(r"[^A-Za-z]", "", text).upper()
                            if len(letters_only) >= MIN_FRAGMENT_LEN:
                                closeup_letters.append(letters_only)
                                closeup_scores.append(float(page_scores[i]) if i < len(page_scores) else 0.0)
                    closeup_conf = (sum(closeup_scores) / len(closeup_scores)) if closeup_scores else 0.0
                    # Only adopt the close-up result if it's actually better
                    # than what the whole-image pass already found -- this
                    # crop is a heuristic guess at the letter region, not a
                    # verified one, so it can occasionally be wrong/empty.
                    if closeup_conf > letter_min_conf_so_far and closeup_letters:
                        letter_lines_deduped, letter_scores_deduped = [], []
                        seen_letters = set()
                        for line, score in zip(closeup_letters, closeup_scores):
                            if line in seen_letters:
                                continue
                            seen_letters.add(line)
                            letter_lines_deduped.append(line)
                            letter_scores_deduped.append(score)
        except Exception:
            # Same isolation principle as the rotation sweep above -- if
            # this secondary, best-effort letter improvement crashes for
            # any reason (including the PaddleX engine crash), the
            # already-good digit/letter result from the main pass is
            # kept intact rather than the whole analysis failing.
            logger.exception("Letter close-up pass failed -- keeping whole-image result")

        if not digit_lines:
            return {
                "ocr_attempted": True,
                "combined_text": "",
                "lines": [],
                "letter_lines": letter_lines_deduped,
                "confidence": 0.0,
                "needs_review": True,
                "error": "No digit text detected",
            }

        combined_text = "".join(digit_lines)
        final_conf = (sum(digit_scores) / len(digit_scores)) if digit_scores else mean_conf
        min_line_conf = min(digit_scores) if digit_scores else final_conf
        # needs_review is now purely a confidence signal -- OCR's own
        # per-line uncertainty -- not a format/structure judgment, since
        # structure varies too much across real tag issuers to encode as
        # a rule. The weakest line decides this, not the average (see
        # the min-vs-average reasoning that's still valid regardless of
        # the format simplification above).
        needs_review = min_line_conf < CONFIDENCE_REVIEW_THRESHOLD

        # NEW -- relative (not absolute) length-consistency check, added
        # back after real testing showed a dropped-digit misread slip
        # through uncaught once the fixed "must be 6 digits" rule was
        # removed ("101616" -> "01616", still confidently shown as
        # correct). Comparing against a fixed number caused a real false
        # positive before (the single-line Bajaj tag) -- comparing a
        # tag's OWN lines against EACH OTHER doesn't have that problem:
        # it only fires when there are 2+ digit lines AND their lengths
        # disagree, which is suspicious regardless of what the "correct"
        # format for that tag actually is. A single-line tag never
        # triggers this at all, since there's nothing to compare it to.
        if len(digit_lines) >= 2:
            lengths = {len(line) for line in digit_lines}
            if len(lengths) > 1:
                needs_review = True

        # NEW -- reinstated after real testing exposed the gap in the
        # relative check above: a tag where BOTH lines were wrong by the
        # SAME amount ("102486"/"584212" both lost their leading digit,
        # -> "02486"/"84212") looked perfectly consistent to that check
        # and got shown as "Looks good" -- a real, wrong answer presented
        # with confidence. Distinguishing this from the earlier "must be
        # 6 digits" mistake: THAT rule also required exactly 2 lines,
        # which broke on a legitimate single-line tag (Bajaj). This is
        # narrower -- only the digit-length-per-line expectation, which
        # has held on every real tag examined, Bajaj's own line included
        # (six digits, same as every two-line tag's lines). A single-line
        # tag isn't exempted the way it was from the old 2-line rule --
        # it's still checked against 6 digits, and every real example
        # has matched.
        if any(len(line) != 6 for line in digit_lines):
            needs_review = True

        # NEW -- separate confidence flag for LETTERS, kept apart from
        # needs_review above rather than folded into it. Letters are
        # often stylized company logos (see _score's comment) that may
        # legitimately never read confidently regardless of angle or
        # preprocessing -- if a weak letter reading forced needs_review
        # True the same way a weak DIGIT reading does, nearly every
        # capture would get flagged for a field that matters less than
        # the tag number, making the main flag far less useful as a
        # signal specifically about the number. This tracks letter
        # uncertainty on its own, without diluting that.
        letter_min_conf = min(letter_scores_deduped) if letter_scores_deduped else 0.0
        letters_need_review = (not letter_lines_deduped) or (letter_min_conf < CONFIDENCE_REVIEW_THRESHOLD)

        return {
            "ocr_attempted": True,
            "combined_text": combined_text,
            "lines": digit_lines,
            "letter_lines": letter_lines_deduped,  # NEW -- was a single best-guess "letter_code"; now every distinct letter fragment found, as-is
            "confidence": round(final_conf, 4),
            "letter_confidence": round(letter_min_conf, 4) if letter_lines_deduped else 0.0,  # NEW
            "letters_need_review": letters_need_review,  # NEW -- separate from needs_review, see comment above
            # NEW -- diagnostic field: EVERY digit-fragment OCR originally
            # detected, with its own confidence, before dedup. Kept for
            # the same reason as before: lets a missing/dropped line be
            # diagnosed later without needing to re-test blind.
            "debug_raw_lines": list(zip(raw_lines, [round(s, 3) for s in scores])),
            "needs_review": needs_review,
            "error": None,
        }

    except Exception as e:
        # Same honesty pattern as exif_service: analysis failing should
        # never break the upload -- record the failure as its own signal.
        logger.exception("Ear tag OCR failed")
        return {
            "ocr_attempted": True,
            "combined_text": "",
            "lines": [],
            "letter_lines": [],
            "confidence": 0.0,
            "letter_confidence": 0.0,
            "letters_need_review": True,
            "debug_raw_lines": [],
            "needs_review": True,
            "error": str(e),
        }


def run_ocr_and_store(capture_id: int, image_bytes: bytes):
    """
    Background-task entry point -- computes OCR and writes the result
    straight to this capture's row, AFTER the upload response has already
    been sent (see api/captures.py's BackgroundTasks usage).
    ⚠️ FIX, found via real testing: OCR used to run synchronously inside
    the upload request itself (awaited via run_in_threadpool). That kept
    the server responsive to OTHER requests, but the ear-tag upload's OWN
    response still didn't return until OCR finished -- two full inference
    passes (0°/180° retry) plus preprocessing can run past the client's
    8-second fetch timeout (static/index.html's fetchWithTimeoutPost_).
    When that happened, the client treated an upload the server actually
    completed as failed, re-queued it for retry, and each retry minted a
    NEW case -- caught by seeing organized_exports fill with duplicate
    case folders and the client's "queued" counter never draining even
    though captures kept landing. Running this fully in the background
    (added AFTER organize_case in api/captures.py's task list, so it
    still runs before it since BackgroundTasks executes in the order
    added) means the upload response returns immediately, independent of
    how long OCR takes.
    """
    import sqlite3
    from services.db import get_conn

    try:
        result = analyze_eartag_ocr(image_bytes)
    except Exception as e:
        logger.exception("Ear tag OCR background task failed")
        result = {
            "ocr_attempted": True, "combined_text": "", "lines": [],
            "letter_lines": [], "confidence": 0.0, "letter_confidence": 0.0,
            "letters_need_review": True,
            "needs_review": True, "error": str(e),
        }

    try:
        conn = get_conn()
        conn.execute(
            "UPDATE captures SET ocr_signals = ? WHERE id = ?",
            (json.dumps(result), capture_id),
        )
        conn.commit()
        conn.close()
    except Exception:
        # ⚠️ FIX: was `except sqlite3.Error`, which only catches DB-layer
        # failures -- a bug ANYWHERE else in this function (like the
        # missing `import json` that caused a real NameError here) fell
        # through uncaught instead, and because this task is scheduled
        # BEFORE organize_case in api/captures.py, an uncaught exception
        # here silently aborted the whole background-task chain for that
        # request -- organize_case never got the chance to run at all,
        # matching a report of "capture succeeded, but organized_exports
        # got nothing." Catching Exception broadly here means this
        # function can now never again block organize_case from running,
        # regardless of what specifically goes wrong inside it.
        logger.exception(f"Failed to store OCR result for capture {capture_id}")
