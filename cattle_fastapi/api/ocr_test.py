# =========================================================================
# OCR TESTING TOOL -- deliberately separate from api/captures.py's real
# upload flow. Takes any image, runs it straight through
# eartag_ocr_service.py, and returns the result immediately. No case,
# no capture row, nothing written to cattle_claims.db or
# organized_exports/ -- this exists purely so OCR accuracy can be tuned
# against any photo without needing to fight the live camera's detection
# gate first. NOT wired into the real claim submission flow, and should
# stay that way -- the live-camera-only requirement for real captures is
# a deliberate anti-fraud decision made earlier in this project (gallery
# upload was removed from every real step for exactly this reason).
# =========================================================================
from fastapi import APIRouter, UploadFile, File

from services.eartag_ocr_service import analyze_eartag_ocr

router = APIRouter(prefix="/api/ocr_test", tags=["ocr_test"])


@router.post("/upload")
async def test_ocr(file: UploadFile = File(...)):
    contents = await file.read()
    result = analyze_eartag_ocr(contents)
    return result
