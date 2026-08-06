"""
Daily Reporter V3 — PDF Search Router

Simplified PDF search tool:
  POST /api/pdf/upload       → Upload PDFs (stored locally in data/specs/)
  POST /api/pdf/ask          → Ask a question about uploaded docs (Gemini)
  GET  /api/pdf/documents    → List all uploaded PDFs
  DELETE /api/pdf/{doc_id}   → Delete a PDF

Storage: local filesystem (data/specs/) instead of R2.
AI: Gemini 2.5 Pro via google-genai SDK.

WHY: This is a construction documentation search tool. Field engineers
need to quickly search specs, plans, and submittals from their phone.
"""

import os
import json
import uuid
import logging
from datetime import datetime
from typing import Any

from fastapi import Depends, APIRouter, UploadFile, File, Form, HTTPException
from PyPDF2 import PdfReader
from io import BytesIO

from app.core.config import GEMINI_API_KEY, GEMINI_MODEL_NAME, GEMINI_THINKING_LEVEL
from app.core.paths import specs_dir

logger = logging.getLogger(__name__)
from app.core.auth import require_user

# Every route below requires a signed-in user, declared once here rather than on
# each endpoint: a per-endpoint decorator is something you can forget to add,
# and forgetting it on a data route would expose one user's records to another.
# require_user also pins the request to that user's storage, which is what makes
# every path in this file resolve inside their own directory.
router = APIRouter(prefix="/api", tags=["pdf-search"], dependencies=[Depends(require_user)])

# Data directory for specs/PDFs



def _get_gemini_client(model_name: str = GEMINI_MODEL_NAME):
    """Initialize the Gemini client (matches ai.py pattern)."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")
    try:
        from google import genai
        client = genai.Client(api_key=GEMINI_API_KEY)
        return client, model_name
    except ImportError:
        raise HTTPException(status_code=500, detail="google-genai not installed")


def _get_metadata_path(doc_id: str) -> str:
    """Get the metadata file path for a document."""
    return os.path.join(specs_dir(), doc_id, "metadata.json")


def _load_metadata(doc_id: str) -> dict[str, Any] | None:
    """Load document metadata from disk."""
    path = _get_metadata_path(doc_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"[pdf] Could not load metadata for {doc_id}: {e}")
        return None


def _save_metadata(doc_id: str, metadata: dict[str, Any]) -> None:
    """Save document metadata to disk."""
    doc_dir = os.path.join(specs_dir(), doc_id)
    os.makedirs(doc_dir, exist_ok=True)
    path = _get_metadata_path(doc_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)


@router.post("/pdf/upload")
async def upload_documents(files: list[UploadFile] = File(...)):
    """Upload one or more PDF files for later searching."""
    uploaded = []

    for file in files:
        try:
            file_id = str(uuid.uuid4())
            doc_dir = os.path.join(specs_dir(), file_id)
            os.makedirs(doc_dir, exist_ok=True)

            # Read file content
            content = await file.read()
            safe_name = (file.filename or "document.pdf").replace(" ", "_")

            # Save PDF file
            pdf_path = os.path.join(doc_dir, safe_name)
            with open(pdf_path, "wb") as f:
                f.write(content)

            # Extract text
            text = ""
            page_count = 0
            try:
                reader = PdfReader(BytesIO(content))
                page_count = len(reader.pages)
                for page in reader.pages:
                    text += (page.extract_text() or "") + "\n"
            except Exception as e:
                logger.error(f"[pdf] Text extraction failed for {file.filename}: {e}")
                text = "[Text extraction failed]"

            # Save extracted text
            txt_path = os.path.join(doc_dir, safe_name + ".txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)

            # Save metadata
            metadata = {
                "id": file_id,
                "filename": file.filename or "document.pdf",
                "safe_filename": safe_name,
                "pdf_path": pdf_path,
                "txt_path": txt_path,
                "page_count": page_count,
                "upload_date": datetime.utcnow().isoformat(),
                "file_size": len(content),
            }
            _save_metadata(file_id, metadata)

            uploaded.append({
                "filename": file.filename,
                "id": file_id,
                "page_count": page_count,
            })
            logger.info(f"[pdf] Uploaded: {file.filename} ({page_count} pages, {len(content)} bytes)")

        except Exception as e:
            logger.error(f"[pdf] Upload error for {file.filename}: {e}")
            uploaded.append({"filename": file.filename, "error": str(e)})

    return {"status": "success", "files": uploaded}


# ============================================
# EXHAUSTIVE SEARCH PROMPT
# WHY: Field engineers need to find EVERYTHING relevant in 300+ page spec books,
#      even when different terminology is used. A generic Q&A prompt misses
#      indirect references, related sections, and alternative wording.
# ============================================

SEARCH_SYSTEM_PROMPT = """You are an EXHAUSTIVE DOCUMENT SEARCH ENGINE for construction engineering documents.

YOUR MISSION: Find EVERY piece of information in the provided document(s) that is relevant to the user's query. You must be thorough — missing a relevant section is a failure.

## SEARCH METHODOLOGY

1. FULL DOCUMENT SCAN: Read EVERY page, EVERY section, EVERY paragraph, EVERY table cell, EVERY note, EVERY footnote, EVERY appendix reference, and EVERY diagram caption. Do not skip anything. Do not skim.

2. SEMANTIC MATCHING: Do NOT rely on exact keyword matching. Understand the INTENT and CONTEXT of the query. Find matches even when:
   - Different terminology is used (e.g., "blow off valve" vs "air release valve" vs "combination air vacuum valve")
   - The information is described indirectly or by reference to another spec section
   - The match is buried in a table, spec reference number, drawing note, or appendix
   - Related components, systems, or assemblies are mentioned
   - Synonyms, abbreviations, or trade-specific jargon is used instead of the queried term

3. CROSS-REFERENCING: If Section A references Section B, and the query relates to Section A, also check Section B and report it. Follow the reference chain.

## RESPONSE FORMAT

For EACH match found, report:

📄 **Page [X] — Section [Y.Z] — [Section Title or Context]**
> "[Exact relevant text quoted verbatim from the document]"
**Why this matches:** [1-2 sentence explanation, especially if different wording is used]
**Match type:** 🔴 DIRECT | 🟡 RELATED | 🔵 CONTEXTUAL

Where:
- 🔴 DIRECT = Explicitly addresses the search query by name or exact concept
- 🟡 RELATED = Contains information about a related component, system, or requirement that the user likely needs
- 🔵 CONTEXTUAL = Provides background, referenced standards, or context that helps understand the topic

## SUMMARY SECTION

After listing all matches, provide:

### Summary
- **Total matches found:** [count]
- **Direct matches:** [count]
- **Related matches:** [count]
- **Contextual matches:** [count]
- **Key findings:** [2-3 sentence synthesis of the most important information found]
- **Sections with NO relevant content:** [list any major sections you scanned that contained nothing relevant — this proves you checked everywhere]

## RULES
1. Report ALL matches, even if there are many. COMPLETENESS over brevity. Every page matters.
2. If two sections reference the same topic independently, report BOTH separately with their own page numbers.
3. Quote the actual text — do not paraphrase the document content.
4. If the query could relate to multiple interpretations, search for ALL interpretations.
5. If NO matches are found, state this clearly and list the sections you DID search to prove thoroughness.
6. Use professional engineering language.
7. Do NOT fabricate content. Only report what is actually in the document.
8. When referencing spec sections, include the full section number (e.g., "Section 33 05 22, Part 2.04.A.3").
"""


@router.post("/pdf/ask")
async def ask_question(
    question: str = Form(...),
    doc_ids: str = Form(...),
    chat_history: str = Form(""),
):
    """
    Exhaustive PDF document search.

    Sends the raw PDF bytes to Gemini for multimodal analysis (reads the actual
    pages including tables, diagrams, and formatting that text extraction misses).
    Uses an aggressive search prompt that requires the model to scan every page
    and report all matches with semantic understanding.
    """
    ids = [i.strip() for i in doc_ids.split(",") if i.strip()]
    if not ids:
        return {"answer": "No documents selected. Please upload and select PDFs first.", "sources": []}

    # Parse chat history
    history: list[dict[str, str]] = []
    if chat_history:
        try:
            history = json.loads(chat_history)
        except (json.JSONDecodeError, TypeError):
            history = []

    client, model_name = _get_gemini_client()

    # Track uploaded files for cleanup
    uploaded_files: list[Any] = []

    try:
        from google.genai import types as genai_types

        # Upload documents via Files API (not inline — avoids size limits)
        doc_names: list[str] = []
        file_parts: list[Any] = []
        total_bytes = 0

        for doc_id in ids:
            meta = _load_metadata(doc_id)
            if not meta:
                logger.warning(f"[pdf/ask] Document {doc_id} not found, skipping")
                continue

            pdf_path = meta.get("pdf_path", "")
            if not os.path.exists(pdf_path):
                logger.warning(f"[pdf/ask] PDF file missing: {pdf_path}")
                continue

            doc_names.append(meta.get("filename", "Unknown"))
            file_size = os.path.getsize(pdf_path)
            total_bytes += file_size

            # Upload to Gemini Files API (handles any size, avoids INVALID_ARGUMENT)
            uploaded = client.files.upload(
                file=pdf_path,
                config={'mime_type': 'application/pdf'},
            )
            uploaded_files.append(uploaded)
            file_parts.append(
                genai_types.Part.from_uri(file_uri=uploaded.uri, mime_type='application/pdf')
            )
            logger.info(f"[pdf/ask] Uploaded document: {meta['filename']} "
                        f"({file_size:,} bytes, {meta.get('page_count', '?')} pages) → {uploaded.name}")

        if not file_parts:
            return {"answer": "Could not load any of the selected documents.", "sources": []}

        # Build conversation context from chat history
        context_str = ""
        if history:
            recent = history[-10:]
            lines = ["Previous conversation:"]
            for msg in recent:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                if role == "user":
                    lines.append(f"User: {content}")
                else:
                    truncated = content[:2000] + "..." if len(content) > 2000 else content
                    lines.append(f"Assistant: {truncated}")
            lines.append("\nNow answer the following new question:")
            context_str = "\n".join(lines) + "\n\n"

        # Document context for the search
        doc_list_str = "\n".join(f"  - {name}" for name in doc_names)
        user_prompt = (
            f"{context_str}"
            f"Documents being searched:\n{doc_list_str}\n\n"
            f"SEARCH QUERY: {question}\n\n"
            f"Execute the full exhaustive search as described in your instructions. "
            f"Scan every page of every document. Report all matches found."
        )

        # Build contents: system prompt + file references + user question
        content_parts: list[Any] = [SEARCH_SYSTEM_PROMPT]
        content_parts.extend(file_parts)
        content_parts.append(user_prompt)

        logger.info(f"[pdf/ask] Exhaustive search across {len(doc_names)} docs "
                    f"({total_bytes:,} bytes total): {question[:100]}...")

        response = client.models.generate_content(
            model=model_name,
            contents=content_parts,
            config=genai_types.GenerateContentConfig(
                thinking_config=genai_types.ThinkingConfig(thinking_level=GEMINI_THINKING_LEVEL),
                max_output_tokens=65536,
            ),
        )

        answer = response.text.strip() if response.text else "The AI returned an empty response."

        logger.info(f"[pdf/ask] Search complete. Response length: {len(answer)} chars")

        return {
            "answer": answer,
            "sources": [{"doc": name, "page": "Full Document Scan", "text": "Exhaustive Multimodal Search"} for name in doc_names],
        }

    except Exception as e:
        logger.exception(f"[pdf/ask] Error: {e}")
        return {
            "answer": f"Error analyzing document: {str(e)}",
            "sources": [],
        }


@router.get("/pdf/documents")
async def list_documents():
    """List all uploaded PDF documents."""
    documents = []

    if not os.path.exists(specs_dir()):
        return {"documents": [], "count": 0}

    for item in os.listdir(specs_dir()):
        item_path = os.path.join(specs_dir(), item)
        if os.path.isdir(item_path):
            meta = _load_metadata(item)
            if meta:
                documents.append({
                    "id": meta["id"],
                    "filename": meta["filename"],
                    "page_count": meta.get("page_count", 0),
                    "upload_date": meta.get("upload_date"),
                    "file_size": meta.get("file_size", 0),
                })

    return {"documents": documents, "count": len(documents)}


@router.delete("/pdf/{doc_id}")
async def delete_document(doc_id: str):
    """Delete a PDF document and its associated files."""
    import shutil

    doc_dir = os.path.join(specs_dir(), doc_id)
    if not os.path.exists(doc_dir):
        raise HTTPException(status_code=404, detail="Document not found")

    meta = _load_metadata(doc_id)
    filename = meta.get("filename", "Unknown") if meta else doc_id

    try:
        shutil.rmtree(doc_dir)
        logger.info(f"[pdf] Deleted: {filename} ({doc_id})")
        return {"status": "success", "message": f"Document '{filename}' deleted"}
    except Exception as e:
        logger.error(f"[pdf] Delete error for {doc_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
