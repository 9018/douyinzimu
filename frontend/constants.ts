/**
 * 应用常量配置
 * 统一管理项目中使用的常量，避免重复定义
 */

/**
 * Aria2 默认配置
 */
export const ARIA2_DEFAULTS = {
  HOST: 'localhost',
  PORT: 6800,
  SECRET: 'douyin_crawler_default_secret',
} as const;

/**
 * 下载配置默认值
 */
export const DOWNLOAD_DEFAULTS = {
  MAX_RETRIES: 3,
  MAX_CONCURRENCY: 5,
} as const;

/**
 * 应用默认设置
 */
export const APP_DEFAULTS = {
  COOKIE: '',
  USER_AGENT: '',
  DOWNLOAD_PATH: '/app/download',
  MAX_RETRIES: DOWNLOAD_DEFAULTS.MAX_RETRIES,
  MAX_CONCURRENCY: DOWNLOAD_DEFAULTS.MAX_CONCURRENCY,
  ENABLE_INCREMENTAL_FETCH: true, // 默认启用增量采集
  ARIA2_HOST: ARIA2_DEFAULTS.HOST,
  ARIA2_PORT: ARIA2_DEFAULTS.PORT,
  ARIA2_SECRET: ARIA2_DEFAULTS.SECRET,
  WEBDAV_ENABLED: false,
  WEBDAV_URL: '',
  WEBDAV_USERNAME: '',
  WEBDAV_PASSWORD: '',
  WEBDAV_BASE_PATH: 'OS/docker',
  WEBDAV_UPLOAD_DOWNLOADS: false,
  WEBDAV_UPLOAD_TRANSFORMED: false,
  SUBTITLE_LANGUAGE: '',
  SUBTITLE_MODE: 'zh',
  SUBTITLE_PROMPT: '',
  SUBTITLE_LOCAL_WHISPER_URL: 'http://host.docker.internal:9001',
  SUBTITLE_LOCAL_MODEL: 'medium',
  SUBTITLE_WORD_TIMESTAMPS: true,
  SUBTITLE_AUTO_GENERATE_ON_UPLOAD: false,
  SUBTITLE_AUTO_BURN_AFTER_GENERATE: false,
} as const;

/**
 * 路径相关常量
 */
export const PATHS = {
  CONFIG_DIR: 'config',
  DOWNLOAD_DIR: 'download',
  SETTINGS_FILE: 'settings.json',
  ARIA2_CONF: 'aria2.conf',
} as const;
