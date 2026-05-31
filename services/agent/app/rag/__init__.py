"""RAG package: Qdrant-backed vector store with a deterministic stub embedder
(no embedding credentials required). Owned entirely by the agent service."""
from __future__ import annotations

import hashlib
import os
import re
from typing import Any, Optional

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

COLLECTION = "knowledge"
DIM = 256

_client: Optional[QdrantClient] = None


def client() -> QdrantClient:
    global _client
    if _client is None:
        url = os.getenv("QDRANT_URL", "http://localhost:6333")
        _client = QdrantClient(url=url)
        _ensure_collection(_client)
    return _client


def _ensure_collection(c: QdrantClient) -> None:
    try:
        existing = {col.name for col in c.get_collections().collections}
        if COLLECTION not in existing:
            c.create_collection(collection_name=COLLECTION, vectors_config=VectorParams(size=DIM, distance=Distance.COSINE))
    except Exception:
        pass


def embed(text: str) -> list[float]:
    """Deterministic hashing embedder (stub). Stable, no credentials. A real
    embedding provider can replace this when EMBEDDING_PROVIDER != 'stub'."""
    vec = [0.0] * DIM
    for tok in re.findall(r"[a-zA-Z0-9]+", text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        vec[h % DIM] += 1.0
    norm = sum(v * v for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


def chunk_text(text: str, size: int = 800, overlap: int = 100) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    i = 0
    while i < len(text):
        chunks.append(text[i : i + size])
        i += size - overlap
    return chunks


def _point_id(document_id: str, ordinal: int) -> str:
    return hashlib.md5(f"{document_id}:{ordinal}".encode()).hexdigest()


def ingest(document_id: str, title: str, text: str, metadata: dict[str, Any]) -> dict[str, Any]:
    c = client()
    chunks = chunk_text(text)
    points = []
    out_chunks = []
    for ordinal, chunk in enumerate(chunks):
        pid = _point_id(document_id, ordinal)
        payload = {
            "document_id": document_id,
            "title": title,
            "ordinal": ordinal,
            "text": chunk,
            "customer_id": metadata.get("customer_id"),
            "project_id": metadata.get("project_id"),
            "workspace_id": metadata.get("workspace_id"),
            "tags": metadata.get("tags", []),
        }
        points.append(PointStruct(id=pid, vector=embed(chunk), payload=payload))
        out_chunks.append({"ordinal": ordinal, "text": chunk, "token_count": len(chunk.split()), "qdrant_point_id": pid})
    if points:
        c.upsert(collection_name=COLLECTION, points=points)
    return {"document_id": document_id, "chunks": out_chunks, "embedding_model": "stub-hash-256"}


def search(query: str, top_k: int = 5, filter: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    c = client()
    qfilter = None
    if filter:
        must = []
        should = []
        if filter.get("workspace_id"):
            must.append(FieldCondition(key="workspace_id", match=MatchValue(value=filter["workspace_id"])))
        for key in ("customer_id", "project_id"):
            if filter.get(key):
                should.append(FieldCondition(key=key, match=MatchValue(value=filter[key])))
        if must or should:
            qfilter = Filter(must=must or None, should=should or None)
    try:
        res = c.query_points(collection_name=COLLECTION, query=embed(query), limit=top_k, query_filter=qfilter, with_payload=True).points
    except Exception:
        return []
    hits = []
    for p in res:
        payload = p.payload or {}
        hits.append({
            "chunk_id": payload.get("chunk_id") or str(p.id),
            "point_id": str(p.id),
            "document_id": payload.get("document_id"),
            "title": payload.get("title"),
            "score": p.score,
            "text": payload.get("text"),
        })
    return hits
