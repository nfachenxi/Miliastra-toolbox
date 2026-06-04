FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖（含 cairosvg 运行时库和 Noto CJK 中文字体）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 \
    libffi-dev \
    shared-mime-info \
    fonts-noto-cjk \
    fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY backend /app/backend
COPY knowledge /app/knowledge

# 设置 Python 路径，让 backend 能找到 knowledge/rag_v1
ENV PYTHONPATH=/app/knowledge/rag_v1

WORKDIR /app/backend

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
