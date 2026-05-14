"""Translation lookup API router."""

from fastapi import APIRouter, HTTPException, Query

from translate import term_service

router = APIRouter()


@router.get("/translate/terms")
async def query_terms(
    query: str = Query(..., min_length=1, description="搜索关键词（中文术语）"),
):
    """按中文术语搜索，返回精确匹配或最相似的 5 条结果及其 15 国翻译。"""
    if not term_service.is_available():
        raise HTTPException(
            status_code=503,
            detail={"success": False, "error": "术语表服务暂不可用"},
        )

    try:
        result = term_service.search(query)
        return {"success": True, "data": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询术语失败: {e}")
