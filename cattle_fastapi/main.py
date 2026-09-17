import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from api import captures, cases, ocr_test  # NEW -- ocr_test is the standalone testing tool, see api/ocr_test.py
from services.db import init_db
from services.eartag_ocr_service import get_ocr_engine  # NEW -- ear tag OCR

app = FastAPI(title="Cattle Claim Validator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    os.makedirs("uploads", exist_ok=True)
    init_db()
    # NEW -- load PaddleOCR eagerly here, not on the first ear_tag upload.
    # Model init is expensive (loads several ONNX models, downloads them
    # on first-ever run) -- doing that lazily would make the first real
    # claimant's ear tag photo the one that eats the multi-second delay.
    get_ocr_engine()


app.include_router(captures.router)
app.include_router(cases.router)
app.include_router(ocr_test.router)  # NEW -- standalone OCR testing, not part of the claim flow

app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")
app.mount("/static", StaticFiles(directory="static", html=True), name="static")


@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    print(f"\n📍 Server: http://localhost:{port}/static/index.html")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
