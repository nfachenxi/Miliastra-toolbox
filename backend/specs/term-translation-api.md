# TermTable 15-Language Translation API — Technical Spec (Revised for 600K Rows)

## 1. Objective

Provide an external HTTP API for searching the `TermTable_15Lang.csv` glossary by Chinese term (`CHS`), returning a candidate list that puts exact containment matches first and fuzzy matches after them, capped at 10 entries.

**Key constraints from review:**
- Delimiter is `\t` (tab).
- Route namespace: `/api/v1/translate`.
- **Prioritise throughput** over memory frugality.
- Term-table failures must be **soft failures** — they must not break other backend features.
- **Dataset size is ~600,000 rows** (not 158K).

---

## 2. Why the 600K Dataset Changes the Architecture

| Dimension | 158K Rows | 600K Rows |
|-----------|-----------|-----------|
| Raw file size | ~80 MB | ~300–400 MB |
| Full in-memory Python objects | ~250 MB | **~1.0–1.2 GB** |
| Linear scan latency (exact) | ~5–20 ms | ~80–300 ms |
| Linear scan latency (fuzzy) | ~10–30 ms | ~100–400 ms |

At 600K rows, loading **all 15 columns** into Python objects consumes ~1 GB per worker, which is unacceptable for multi-worker deployments. A pure linear scan also exceeds acceptable latency for a synchronous HTTP endpoint.

**Therefore, we switch to a hybrid design:**
- **SQLite + FTS5** for high-throughput exact containment queries.
- **In-memory CHS index only** (~80 MB) for rapidfuzz fallback.

---

## 3. Architecture: SQLite + FTS5 + In-Memory CHS Index

### 3.1 Overview

```
TermTable_15Lang.csv
        │
        ▼ (build step)
   terms.db  (SQLite on disk)
   ├── table: terms       (15 columns + rowid)
   └── virtual table: terms_fts  (FTS5 on CHS, unicode61 tokenizer)
        │
        ├──► Exact queries: FTS5 MATCH  (disk-based inverted index, < 10 ms)
        │
        └──► Fuzzy queries: SELECT rowid, chs INTO memory list
                  rapidfuzz.extract(..., limit=20)
                  SQLite batch SELECT rowids (up to 10 rows, < 5 ms)
```

### 3.2 Rationale

| Concern | Solution | Why it wins |
|---------|----------|-------------|
| **Memory** | Only `rowid + chs` loaded into memory (~80 MB) | 15 translation columns stay on disk |
| **Exact throughput** | FTS5 inverted index on `CHS` | Sub-10 ms per query, independent of table size |
| **Fuzzy throughput** | `rapidfuzz` C++ scorer on compact `list[str]` | 100–200 ms for 600K rows, acceptable for fallback |
| **Correctness** | Python `query in row['chs']` post-filter on FTS5 candidates | Eliminates FTS5 token-boundary false positives |
| **Fault isolation** | Soft-failure in `lifespan`; `terms.db` auto-built if missing | Other APIs unaffected |

---

## 4. Data Storage Detail

### 4.1 SQLite Schema

```sql
-- Main table: holds all translations. Never loaded fully into memory.
CREATE TABLE terms (
    chs TEXT,
    cht TEXT,
    de  TEXT,
    en  TEXT,
    es  TEXT,
    fr  TEXT,
    id  TEXT,
    it  TEXT,
    jp  TEXT,
    kr  TEXT,
    pt  TEXT,
    ru  TEXT,
    th  TEXT,
    tr  TEXT,
    vi  TEXT
);

-- FTS5 virtual table: full-text index on CHS only.
-- unicode61 tokenizer splits CJK characters per-char, so MATCH '黑名单'
-- matches rows containing the token sequence [黑, 名, 单].
CREATE VIRTUAL TABLE terms_fts USING fts5(chs, tokenize='unicode61');
```

### 4.2 Build Step

**Script**: `backend/scripts/build_terms_db.py`

```bash
python backend/scripts/build_terms_db.py TermTable_15Lang.csv
# outputs backend/data/terms.db
```

**Runtime auto-build** (in `lifespan`, first start only):
- If `terms.db` does not exist, read TSV and import into SQLite + FTS5.
- 600K rows import: ~15–30 seconds (one-time cost).
- Log progress every 100K rows.

**Git strategy**: `terms.db` is added to `.gitignore` (too large for git). CI/build pipeline can generate it, or the server builds it on first boot.

---

## 5. Search Behaviour

### 5.1 Phase 1 — Exact Containment

**Goal**: `CHS` column contains the user `query` as a substring.

**Algorithm**:
1. Sanitize `query` for FTS5 (escape double quotes, wrap in phrase quotes).
2. Execute:
   ```sql
   SELECT rowid, chs, cht, de, en, es, fr, id, it, jp, kr, pt, ru, th, tr, vi
   FROM terms
   WHERE rowid IN (
       SELECT rowid FROM terms_fts WHERE chs MATCH ?
   )
   ```
3. Post-filter in Python: `query.lower() in row['chs'].lower()`.
   - This removes rare false positives where FTS5 matches non-contiguous tokens.
   - Candidate set from FTS5 is typically small (0–500 rows), so post-filter is instant.
4. Return all hits with full 15-language translations.

**Latency**: **< 10 ms** for typical queries (FTS5 index seek dominates).

### 5.2 Phase 2 — Fuzzy Supplement

**Trigger**: always run when the candidate list is still below 10 after Phase 1.

**Algorithm**:
1. Run `rapidfuzz.process.extract(query, chs_list, scorer=fuzz.partial_ratio, limit=20)`.
   - `chs_list` is the in-memory `list[str]` of all 600K Chinese terms (~80 MB).
   - `partial_ratio` chosen because users often type fragments inside longer terms.
2. Exclude `rowid`s already returned by Phase 1, then map the remaining matches to `rowid`s.
3. Batch-fetch full translations:
   ```sql
  SELECT * FROM terms WHERE rowid IN (?, ..., ?)
   ```
4. Append fuzzy candidates after exact matches until the combined list reaches 10 items.

**Return shape**:
- `exact_match=true` means the list contains at least one exact containment hit.
- `results` are ordered as exact hits first, fuzzy supplements second.
- `total <= 10`.

**Latency**: **50–200 ms** (rapidfuzz over 600K rows in C++).

### 5.3 Tie-Breaking
If multiple terms share the same `partial_ratio` score, fallback to **original CSV row order** (stable, deterministic, zero extra cost).

---

## 6. Fault Isolation — Soft Failure Design

**Requirement**: Missing/corrupted `TermTable_15Lang.csv` or `terms.db` must not affect any other API.

### 6.1 Lifespan Initialisation

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        term_service.initialise("TermTable_15Lang.csv")
    except Exception:
        # Logged inside service. Other features continue unaffected.
        pass

    task = asyncio.create_task(openrouter_availability_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
```

### 6.2 Service State Machine

```python
class TermService:
    def __init__(self):
        self._available = False
        self._db_path: str | None = None
        self._chs_list: list[str] = []
        self._rowid_list: list[int] = []

    def is_available(self) -> bool:
        return self._available

    def initialise(self, csv_path: str) -> None:
        try:
            db_path = self._ensure_db(csv_path)
            self._load_chs_index(db_path)
            self._db_path = db_path
            self._available = True
        except Exception as e:
            logger.error("Term service initialisation failed: %s", e)
            self._available = False
```

### 6.3 API Degradation

```python
@router.get("/translate/terms")
async def query_terms(query: str = Query(..., min_length=1)):
    if not term_service.is_available():
        raise HTTPException(
            status_code=503,
            detail={"success": False, "error": "术语表服务暂不可用"}
        )
    ...
```

---

## 7. API Contract

### Endpoint
```http
GET /api/v1/translate/terms?query={keyword}
```

### Parameters
| Name  | Type   | Required | Constraints |
|-------|--------|----------|-------------|
| query | string | yes      | min_length=1 |

### Success 200 — Exact Match
```json
{
  "success": true,
  "data": {
    "exact_match": true,
    "query": "黑名单",
    "total": 3,
    "results": [
      {
        "chs": "\"PlayStation Network\"的好友列表黑名单",
        "cht": "...",
        "de": "...",
        "en": "...",
        "es": "...",
        "fr": "...",
        "id": "...",
        "it": "...",
        "jp": "...",
        "kr": "...",
        "pt": "...",
        "ru": "...",
        "th": "...",
        "tr": "...",
        "vi": "..."
      }
    ]
  }
}
```

### Success 200 — Fuzzy Fallback
```json
{
  "success": true,
  "data": {
    "exact_match": false,
    "message": "未找到完全包含该关键词的术语，以下是最相似的 5 条结果",
    "query": "某某词",
    "total": 5,
    "results": [ /* 5 items */ ]
  }
}
```

### Error Responses
- `400` — missing or empty `query`
- `503` — term service unavailable (CSV/DB missing or unreadable)
- `500` — unexpected runtime error during search

---

## 8. Module Design

### Directory Layout

```text
backend/
  translate/
    __init__.py
    service.py          # TermService: DB builder + FTS5 exact + rapidfuzz fallback
    router.py           # GET /translate/terms
  scripts/
    build_terms_db.py   # CLI: CSV → SQLite + FTS5 (optional manual build)
```

### `translate/service.py` Responsibilities
1. `_ensure_db(csv_path) -> db_path`  
   - If `terms.db` exists and schema is valid → return path.  
   - Else parse TSV → populate `terms` + `terms_fts` → commit.
2. `_load_chs_index(db_path)`  
   - `SELECT rowid, chs FROM terms` → parallel `list[int]` + `list[str]`.
3. `search(query: str) -> SearchResult`  
   - Phase 1: FTS5 MATCH + Python `in` post-filter.  
  - Phase 2: `rapidfuzz.extract(..., limit=20)` + SQLite batch SELECT, excluding exact rowids and capping the merged list at 10.

### `translate/router.py`
```python
router = APIRouter()

@router.get("/translate/terms")
async def query_terms(query: str = Query(..., min_length=1)):
    if not term_service.is_available():
        raise HTTPException(status_code=503, detail="术语表服务暂不可用")
    result = term_service.search(query)
    return {"success": True, "data": result}
```

### `main.py` Changes
1. Import `translate.router` and `translate.service`.
2. Register router: `app.include_router(translate_router, prefix="/api/v1")`.
3. In `lifespan`, call `term_service.initialise(...)` inside a `try/except` block.

---

## 9. Dependencies

Add to `backend/requirements.txt`:
```text
rapidfuzz
```

- `rapidfuzz` (~1 MB wheel, C++ backend, no system deps) — required for high-throughput fuzzy fallback over 600K rows.
- **No pandas**: Standard library `csv.DictReader` with `delimiter="\t"` handles the file; `sqlite3` is in the stdlib.

---

## 10. Performance Budget (600K Rows)

| Stage                              | Time       | Memory (runtime) |
|------------------------------------|------------|------------------|
| First-start CSV → SQLite + FTS5    | ~15–30 s   | ~100 MB (spike)  |
| Startup: load CHS index            | ~1–2 s     | ~80 MB           |
| Exact query (FTS5 + post-filter)   | **< 10 ms**| —                |
| Fuzzy query (rapidfuzz 600K)       | **50–200 ms**| —              |
| SQLite batch fetch (5 rows)        | **< 5 ms** | —                |
| Single-worker exact-query RPS      | **> 1,000**| —                |
| Single-worker fuzzy-query RPS      | **~5–20**  | —                |

---

## 11. Live Verification

Deployed and verified on `https://ugc.070077.xyz`.

### Exact Match Example

```bash
curl -sL "https://ugc.070077.xyz/api/v1/translate/terms?query=%E9%BB%91%E5%90%8D%E5%8D%95"
```

Response (truncated):
```json
{
  "success": true,
  "data": {
    "exact_match": true,
    "query": "黑名单",
    "total": 2,
    "results": [
      {
        "rowid": 496053,
        "chs": "黑名单",
        "cht": "黑名單",
        "de": "Schwarze Liste",
        "en": "Blocklist",
        "es": "Lista negra",
        "fr": "Liste noire",
        "id": "Blacklist",
        "it": "Lista utenti bloccati",
        "jp": "ブラックリスト",
        "kr": "블랙리스트",
        "pt": "Lista Negra",
        "ru": "Чёрный список",
        "th": "แบล็คลิสต์",
        "tr": "Engellenenler",
        "vi": "Danh Sách Đen"
      },
      {
        "rowid": 496054,
        "chs": "黑名单  {0} / {1}",
        ...
      }
    ]
  }
}
```

### Fuzzy Fallback Example

```bash
curl -sL "https://ugc.070077.xyz/api/v1/translate/terms?query=xyznotfound"
```

Response (truncated):
```json
{
  "success": true,
  "data": {
    "exact_match": false,
    "message": "未找到完全包含该关键词的术语，以下是最相似的 5 条结果",
    "query": "xyznotfound",
    "total": 5,
    "results": [
      {
        "rowid": 26708,
        "chs": "x",
        "cht": "x",
        "de": "×",
        "en": "×",
        ...
      }
    ]
  }
}
```

---

## 12. Implementation Checklist

- [x] Create `backend/translate/__init__.py`
- [x] Create `backend/translate/service.py` (`TermService` with DB builder, FTS5 exact, rapidfuzz fallback)
- [x] Create `backend/translate/router.py` (`GET /translate/terms`)
- [x] Create `backend/scripts/build_terms_db.py` (optional standalone builder)
- [x] Update `backend/main.py` (include router, soft-failure lifespan init)
- [x] Add `rapidfuzz` to `backend/requirements.txt`
- [x] Add `*.db` to `.gitignore`
- [ ] Add `backend/tests/test_translate_api.py`
- [ ] Update `backend/api.md` if applicable
