# Stage 1: 构建前端
FROM node:20-alpine AS frontend-builder

ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

WORKDIR /app/frontend

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY frontend/ ./
RUN pnpm build

# Stage 2: Python 后端运行时
FROM nikolaik/python-nodejs:python3.12-nodejs22-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# 安装运行依赖（ffmpeg 用于视频转码）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 安装 pnpm（用于挂载前端源码时在容器内构建 dist）
RUN corepack enable

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist/

CMD ["python", "-m", "backend.server", "--host", "0.0.0.0", "--port", "8000"]
