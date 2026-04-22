# Stage 1: 构建前端
FROM node:20-alpine AS frontend-builder

ARG VITE_API_BASE_URL=
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
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

# 切换 apt 镜像源（中国大陆环境加速）
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources; \
    fi

# 安装构建依赖 + aria2 + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    pkg-config \
    libcairo2-dev \
    libgirepository1.0-dev \
    libgtk-3-dev \
    libwebkit2gtk-4.1-dev \
    libglib2.0-dev \
    aria2 \
    docker.io \
    ffmpeg \
    fontconfig \
    fonts-noto-cjk \
    fonts-wqy-zenhei \
    tzdata \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 安装 pnpm（用于挂载前端源码时在容器内构建 dist）
RUN corepack enable

COPY requirements.txt ./
RUN pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY . ./
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist/

CMD ["python", "-m", "backend.server", "--host", "0.0.0.0", "--port", "8000"]
