/**
 * 统一的 HTTP API 封装
 * 
 * 提供简洁的 API 调用方式，如：
 * - api.settings.get()
 * - api.task.start({ type, target, limit })
 * - api.aria2.config()
 */

import { AppSettings, TaskType, DouyinWork } from '../types';

// ============================================================================
// 配置
// ============================================================================

function resolveApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
  }

  return 'http://127.0.0.1:8000';
}

const API_BASE_URL = resolveApiBaseUrl();

// ============================================================================
// 类型定义
// ============================================================================

/** API 错误 */
export class APIError extends Error {
  constructor(
    public statusCode: number,
    public detail: string
  ) {
    super(detail);
    this.name = 'APIError';
  }
}

/** 任务启动参数 */
export interface StartTaskParams {
  type: TaskType | string;
  target: string;
  limit?: number;
  filters?: Record<string, string>;
}

/** 任务响应 */
export interface TaskResponse {
  task_id: string;
  status: string;
}

/** 任务状态 */
export interface TaskStatus {
  id: string;
  type: string;
  target: string;
  status: 'running' | 'completed' | 'error';
  progress: number;
  result_count: number;
  error?: string;
  created_at: number;
  updated_at: number;
  aria2_conf?: string;
}

/** 健康状态 */
export interface HealthStatus {
  ready: boolean;
  aria2: boolean;
  config: boolean;
  error?: string;
}

/** Aria2 配置 */
export interface Aria2Config {
  host: string;
  port: number;
  secret: string;
}

export interface VideoFileItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

export interface VideoInfo {
  name: string;
  path: string;
  duration: number;
  size: number;
  bit_rate: number;
  codec: string;
  width: number;
  height: number;
  frame_rate: string;
}

export interface TransformVideoResult {
  success: boolean;
  output_path: string | null;
  subtitle_path: string | null;
  subtitle_json_path: string | null;
  subtitle_wav_path: string | null;
  error: string | null;
}

export interface TransformSubtitleOptions {
  generate_subtitles?: boolean;
  subtitle_language?: string;
  subtitle_prompt?: string;
}

export interface GenerateSubtitleResult {
  success: boolean;
  subtitle_path: string | null;
  subtitle_json_path: string | null;
  subtitle_wav_path: string | null;
  error: string | null;
}

export interface SubtitleCue {
  index: number;
  start: string;
  end: string;
  text: string;
}

export interface SubtitleFileResult {
  success: boolean;
  file_path: string | null;
  cues: SubtitleCue[];
  error: string | null;
}

export interface BurnSubtitleOptions {
  font_name?: string;
  font_size?: number;
  margin_v?: number;
  outline?: number;
  shadow?: number;
  primary_color?: string;
  outline_color?: string;
  alignment?: number;
}

export interface BurnSubtitleResult {
  success: boolean;
  output_path: string | null;
  error: string | null;
}

export interface SubtitleApiTestResult {
  success: boolean;
  detail: string | null;
}

export interface WebDAVUploadResult {
  success: boolean;
  remote_path: string | null;
  error: string | null;
}

export interface WebDAVConfig {
  webdav_url: string;
  webdav_username: string;
  webdav_password: string;
  webdav_base_path: string;
}

export interface LocalCopyResult {
  success: boolean;
  output_path: string | null;
  error: string | null;
}

export interface WebDAVDirectoryItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface WebDAVDirectoryResult {
  success: boolean;
  entries: WebDAVDirectoryItem[];
  error: string | null;
}

export interface WebDAVTestResult {
  success: boolean;
  error: string | null;
}

export interface LocalEntryItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface LocalDirectoryResult {
  success: boolean;
  entries: LocalEntryItem[];
  error: string | null;
}

export interface GenericPathResult {
  success: boolean;
  path: string | null;
  error: string | null;
}

// ============================================================================
// 核心请求函数
// ============================================================================

/**
 * 通用 fetch 封装
 */
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: response.statusText }));
    throw new APIError(response.status, errorData.detail || `HTTP ${response.status}`);
  }
  
  return response.json();
}

/**
 * GET 请求
 */
async function get<T>(endpoint: string): Promise<T> {
  return fetchAPI<T>(endpoint, { method: 'GET' });
}

/**
 * POST 请求
 */
async function post<T>(endpoint: string, body?: unknown): Promise<T> {
  return fetchAPI<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// API 模块
// ============================================================================

export const api = {
  /** 基础 URL */
  baseUrl: API_BASE_URL,
  
  /** 健康检查 */
  health: () => get<HealthStatus>('/api/health'),
  
  /** 检查后端是否可用 */
  isAvailable: async (): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE_URL}/api`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  },
  
  /** 等待后端就绪 */
  waitForReady: async (timeout: number = 30000): Promise<boolean> => {
    const startTime = Date.now();
    const checkInterval = 500;
    
    while (Date.now() - startTime < timeout) {
      if (await api.isAvailable()) {
        console.log(`[API] 后端服务已就绪 (${Date.now() - startTime}ms)`);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    console.error('[API] 连接超时');
    return false;
  },
  
  // ========================================================================
  // 设置管理
  // ========================================================================
  settings: {
    /** 获取当前设置 */
    get: () => get<AppSettings>('/api/settings'),
    
    /** 保存设置（支持部分更新） */
    save: (data: Partial<AppSettings>) => 
      post<{ status: string; message: string }>('/api/settings', data),
    
    /** 检查是否首次运行 */
    isFirstRun: async () => {
      const result = await get<{ is_first_run: boolean }>('/api/settings/first-run');
      return result.is_first_run;
    },
  },
  
  // ========================================================================
  // 任务管理
  // ========================================================================
  task: {
    /** 启动采集任务 */
    start: (params: StartTaskParams) => 
      post<TaskResponse>('/api/task/start', {
        type: params.type,
        target: params.target,
        limit: params.limit ?? 0,
        filters: params.filters ?? null,
      }),
    
    /** 获取任务状态 */
    status: (taskId?: string) => {
      const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : '';
      return get<TaskStatus[]>(`/api/task/status${query}`);
    },
    
    /** 获取任务结果 */
    results: (taskId: string) => 
      get<DouyinWork[]>(`/api/task/results/${encodeURIComponent(taskId)}`),
  },
  
  // ========================================================================
  // Aria2 管理
  // ========================================================================
  aria2: {
    /** 获取 Aria2 配置 */
    config: () => get<Aria2Config>('/api/aria2/config'),
    
    /** 获取 Aria2 状态 */
    status: async () => {
      const result = await get<{ connected: boolean }>('/api/aria2/status');
      return result.connected;
    },
    
    /** 启动 Aria2 服务 */
    start: () => post<{ status: string; message: string }>('/api/aria2/start'),
    
    /** 获取配置文件路径 */
    configPath: async (taskId?: string) => {
      const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : '';
      const result = await get<{ config_path: string }>(`/api/aria2/config-path${query}`);
      return result.config_path;
    },
  },
  
  // ========================================================================
  // 文件操作
  // ========================================================================
  file: {
    /** 打开文件夹 */
    openFolder: async (path: string) => {
      const result = await post<{ success: boolean }>('/api/file/open-folder', { folder_path: path });
      return result.success;
    },
    
    /** 检查文件是否存在 */
    checkExists: async (path: string) => {
      const result = await post<{ exists: boolean }>('/api/file/check-exists', { file_path: path });
      return result.exists;
    },
    
    /** 读取配置文件 */
    readConfig: async (path: string) => {
      const result = await post<{ content: string }>('/api/file/read-config', { file_path: path });
      return result.content;
    },

    /** 查找本地已下载文件 */
    findLocal: (workId: string) =>
      get<{ found: boolean; video_path: string | null; images: string[] | null }>(
        `/api/file/find-local/${encodeURIComponent(workId)}`
      ),

    /** 获取下载目录内视频文件 */
    listVideos: async () => {
      const result = await get<{ files: VideoFileItem[] }>('/api/file/videos');
      return result.files;
    },

    /** 视频转码 */
    transformVideo: (filePath: string, ffmpegArgs: string, subtitleOptions?: TransformSubtitleOptions) =>
      post<TransformVideoResult>('/api/file/transform', {
        file_path: filePath,
        ffmpeg_args: ffmpegArgs,
        ...(subtitleOptions ?? {}),
      }),

    /** 单独生成字幕 */
    generateSubtitles: (filePath: string, subtitleOptions?: Omit<TransformSubtitleOptions, 'generate_subtitles'>) =>
      post<GenerateSubtitleResult>('/api/file/subtitles', {
        file_path: filePath,
        ...(subtitleOptions ?? {}),
      }),

    /** 读取字幕文件 */
    readSubtitleFile: (filePath: string) =>
      post<SubtitleFileResult>('/api/file/subtitle/read', {
        file_path: filePath,
      }),

    /** 保存字幕文件 */
    saveSubtitleFile: (filePath: string, cues: SubtitleCue[]) =>
      post<SubtitleFileResult>('/api/file/subtitle/save', {
        file_path: filePath,
        cues,
      }),

    /** 烧录内嵌字幕 */
    burnSubtitleFile: (
      videoPath: string,
      subtitlePath: string,
      options?: BurnSubtitleOptions
    ) =>
      post<BurnSubtitleResult>('/api/file/subtitle/burn', {
        video_path: videoPath,
        subtitle_path: subtitlePath,
        ...(options ?? {}),
      }),

    /** 测试本地 Whisper */
    testSubtitleApi: () =>
      post<SubtitleApiTestResult>('/api/file/subtitle/test-api'),

    /** 视频基础信息 */
    videoInfo: (filePath: string) =>
      post<{ success: boolean; info: VideoInfo; error: string | null }>('/api/file/video-info', {
        file_path: filePath,
      }),

    /** 复制到本地目录 */
    copyToLocal: (filePath: string, targetDir: string) =>
      post<LocalCopyResult>('/api/file/copy-local', {
        file_path: filePath,
        target_dir: targetDir,
      }),

    /** 列出本地目录 */
    listLocalEntries: (path: string) =>
      post<LocalDirectoryResult>('/api/file/local-list', {
        path,
      }),

    /** 本地新建目录 */
    createLocalDirectory: (targetDir: string, name: string) =>
      post<GenericPathResult>('/api/file/local-mkdir', {
        target_dir: targetDir,
        name,
      }),

    /** 本地重命名 */
    renameLocalPath: (path: string, newName: string) =>
      post<GenericPathResult>('/api/file/local-rename', {
        path,
        new_name: newName,
      }),

    /** 本地删除 */
    deleteLocalPath: (path: string) =>
      post<GenericPathResult>('/api/file/local-delete', {
        path,
      }),

    /** 上传到 WebDAV */
    uploadToWebDAV: (
      filePath: string,
      category: 'download' | 'transform' = 'download',
      remoteDir?: string,
      config?: WebDAVConfig
    ) =>
      post<WebDAVUploadResult>('/api/file/upload-webdav', {
        file_path: filePath,
        category,
        remote_dir: remoteDir,
        ...(config ?? {}),
      }),

    /** 测试 WebDAV 连接 */
    testWebDAV: (config: WebDAVConfig) => post<WebDAVTestResult>('/api/file/webdav/test', config),

    /** 列出 WebDAV 目录 */
    listWebDAVDirectories: (config: WebDAVConfig & { remote_dir?: string }) =>
      post<WebDAVDirectoryResult>('/api/file/webdav/list', config),

    /** WebDAV 新建目录 */
    createWebDAVDirectory: (config: WebDAVConfig & { target_dir: string; name: string }) =>
      post<GenericPathResult>('/api/file/webdav/mkdir', config),

    /** WebDAV 重命名 */
    renameWebDAVPath: (config: WebDAVConfig & { path: string; new_name: string }) =>
      post<GenericPathResult>('/api/file/webdav/rename', config),

    /** WebDAV 删除 */
    deleteWebDAVPath: (config: WebDAVConfig & { path: string }) =>
      post<GenericPathResult>('/api/file/webdav/delete', config),

    /** 获取媒体文件 URL */
    getMediaUrl: (filePath: string) => {
      // 将路径分段编码，保留路径分隔符
      const encodedPath = filePath
        .split(/[/\\]/)
        .map(segment => encodeURIComponent(segment))
        .join('/');
      return `${API_BASE_URL}/api/file/media/${encodedPath}`;
    },
  },
  
  // ========================================================================
  // 系统工具
  // ========================================================================
  system: {
    /** 获取剪贴板内容 */
    clipboard: async () => {
      const result = await get<{ text: string }>('/api/system/clipboard');
      return result.text;
    },
    
    /** 打开外部链接（GUI 模式使用） */
    openUrl: (url: string) => 
      post<{ status: string; message: string }>('/api/system/open-url', { url }),

    /** 通过登录获取 Cookie（仅 GUI 模式） */
    cookieLogin: () =>
      post<{ success: boolean; cookie: string; user_agent: string; error: string }>(
        '/api/system/cookie-login'
      ),
  },
};

export default api;
