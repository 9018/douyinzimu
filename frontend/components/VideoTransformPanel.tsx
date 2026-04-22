import {
  Captions,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Copy,
  Download,
  File,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Save,
  Server,
  TestTube2,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../services/bridge';
import type { SubtitleCue } from '../services/api';
import { logger } from '../services/logger';
import { AppSettings } from '../types';
import { toast } from './Toast';

interface VideoTransformPanelProps {
  mode?: 'file-manager' | 'subtitle-workshop' | 'subtitle-workshop-mobile';
}

interface VideoFileItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

interface VideoInfo {
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

interface WebDAVDirectoryItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

interface LocalEntryItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

const defaultArgs =
  '-vf "scale=1080:-2,format=yuv420p" -c:v libx264 -crf 19 -preset medium -profile:v high -level 4.1 -movflags +faststart -c:a aac -b:a 128k';
const ffmpegPresetStorageKey = 'douyin.ffmpeg.presets.v1';
const legacyDefaultSubtitlePrompt = '请输出简体中文（简体字），不要使用繁体字。';

const buildSubtitlePath = (videoPath: string) => {
  const dotIndex = videoPath.lastIndexOf('.');
  if (dotIndex === -1) return `${videoPath}.srt`;
  return `${videoPath.slice(0, dotIndex)}.srt`;
};

const formatSize = (bytes: number) => {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
};

const formatDate = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });

const formatDuration = (seconds: number) => {
  if (!seconds) return '未知';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const emptyWebDAVSettings = {
  webdavEnabled: false,
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  webdavBasePath: 'OS/docker',
  webdavUploadDownloads: false,
  webdavUploadTransformed: false,
};

const emptySubtitleSettings = {
  subtitleLanguage: '',
  subtitleMode: 'zh',
  subtitlePrompt: '',
  subtitleLocalWhisperUrl: 'http://host.docker.internal:9001',
  subtitleLocalModel: 'medium',
  subtitleWordTimestamps: true,
  subtitleAutoGenerateOnUpload: false,
  subtitleAutoBurnAfterGenerate: false,
};

const subtitleModeOptions = [
  { value: 'zh', label: '中文字幕' },
  { value: 'mixed', label: '保留原声（中英混合推荐）' },
  { value: 'en', label: '英文字幕' },
  { value: 'bilingual', label: '原文 + 英文翻译' },
];

const subtitleFontOptions = [
  'WenQuanYi Zen Hei',
  'Noto Sans CJK SC',
  'Noto Sans CJK TC',
  'Noto Sans CJK JP',
  'Source Han Sans SC',
  'Microsoft YaHei',
  'PingFang SC',
  'Arial Unicode MS',
];

const subtitleFontSizeOptions = [14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48, 56, 64, 72, 84, 96];
const subtitleMarginVOptions = [8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64];
const subtitleOutlineOptions = [0, 1, 2, 3, 4, 5, 6];
const subtitleShadowOptions = [0, 1, 2, 3, 4, 5, 6];

const defaultBurnSettings = {
  fontName: 'WenQuanYi Zen Hei',
  fontSize: 18,
  marginV: 24,
  outline: 2,
  shadow: 0,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  alignment: 2,
  usePrecisePosition: false,
  positionX: 50,
  positionY: 86,
};

const subtitleAlignmentOptions = [
  { value: 1, label: '左下' },
  { value: 2, label: '中下' },
  { value: 3, label: '右下' },
  { value: 7, label: '左上' },
  { value: 8, label: '中上' },
  { value: 9, label: '右上' },
];

const parseSubtitleTimestampToSeconds = (timestamp: string) => {
  if (!timestamp || typeof timestamp !== 'string') {
    return 0;
  }
  const normalized = timestamp.replace('.', ',').trim();
  const [timePart = '00:00:00', milliseconds = '0'] = normalized.split(',');
  const [hours = '0', minutes = '0', seconds = '0'] = timePart.split(':');
  const parsed =
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000;
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeSubtitleTimestamp = (value: unknown, fallback: string) => {
  const raw = String(value ?? '').replace('.', ',').trim();
  if (/^\d{2}:\d{2}:\d{2},\d{1,3}$/.test(raw)) {
    const [timePart, msPart = '0'] = raw.split(',');
    return `${timePart},${msPart.padStart(3, '0').slice(0, 3)}`;
  }
  return fallback;
};

const normalizeSubtitleCues = (rawCues: unknown): SubtitleCue[] => {
  if (!Array.isArray(rawCues)) {
    return [];
  }
  return rawCues.map((rawCue, index) => {
    const cue = (rawCue || {}) as Partial<SubtitleCue>;
    return {
      index: Number(cue.index) > 0 ? Number(cue.index) : index + 1,
      start: normalizeSubtitleTimestamp(cue.start, '00:00:00,000'),
      end: normalizeSubtitleTimestamp(cue.end, '00:00:01,000'),
      text: String(cue.text ?? ''),
    };
  });
};

const buildSrtFromCues = (cues: SubtitleCue[]) => {
  return cues
    .map((cue, index) => `${index + 1}\n${cue.start} --> ${cue.end}\n${String(cue.text ?? '').trim()}\n`)
    .join('\n')
    .trim() + (cues.length ? '\n' : '');
};

const downloadBlob = (filename: string, content: string, type: string) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const VideoTransformPanel: React.FC<VideoTransformPanelProps> = ({
  mode = 'subtitle-workshop',
}) => {
  const [files, setFiles] = useState<VideoFileItem[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [ffmpegArgs, setFfmpegArgs] = useState(defaultArgs);
  const [ffmpegPresets, setFfmpegPresets] = useState<string[]>([defaultArgs]);
  const [selectedFfmpegPreset, setSelectedFfmpegPreset] = useState(defaultArgs);
  const [loading, setLoading] = useState(false);
  const [transforming, setTransforming] = useState(false);
  const [generatingSubtitlesOnly, setGeneratingSubtitlesOnly] = useState(false);
  const [copyTargetDir, setCopyTargetDir] = useState('/app/download');
  const [localBrowsePath, setLocalBrowsePath] = useState('/app/download');
  const [localEntries, setLocalEntries] = useState<LocalEntryItem[]>([]);
  const [loadingLocalEntries, setLoadingLocalEntries] = useState(false);
  const [selectedLocalDir, setSelectedLocalDir] = useState('');
  const [selectedLocalEntryPath, setSelectedLocalEntryPath] = useState('');
  const [selectedLocalEntryName, setSelectedLocalEntryName] = useState('');
  const [selectedLocalEntryIsDir, setSelectedLocalEntryIsDir] = useState(false);
  const [newLocalFolderName, setNewLocalFolderName] = useState('');
  const [renameLocalName, setRenameLocalName] = useState('');
  const [creatingLocalFolder, setCreatingLocalFolder] = useState(false);
  const [renamingLocal, setRenamingLocal] = useState(false);
  const [deletingLocal, setDeletingLocal] = useState(false);
  const [copyingLocal, setCopyingLocal] = useState(false);
  const [uploadingWebDAV, setUploadingWebDAV] = useState(false);
  const [savingWebDAV, setSavingWebDAV] = useState(false);
  const [testingWebDAV, setTestingWebDAV] = useState(false);
  const [listingWebDAV, setListingWebDAV] = useState(false);
  const [webdavDirectories, setWebdavDirectories] = useState<WebDAVDirectoryItem[]>([]);
  const [selectedRemoteDir, setSelectedRemoteDir] = useState('');
  const [selectedRemoteEntryPath, setSelectedRemoteEntryPath] = useState('');
  const [selectedRemoteEntryName, setSelectedRemoteEntryName] = useState('');
  const [selectedRemoteEntryIsDir, setSelectedRemoteEntryIsDir] = useState(false);
  const [newRemoteFolderName, setNewRemoteFolderName] = useState('');
  const [renameRemoteName, setRenameRemoteName] = useState('');
  const [creatingRemoteFolder, setCreatingRemoteFolder] = useState(false);
  const [renamingRemote, setRenamingRemote] = useState(false);
  const [deletingRemote, setDeletingRemote] = useState(false);
  const [webdavSettings, setWebdavSettings] = useState({
    ...emptyWebDAVSettings,
  });
  const [subtitleSettings, setSubtitleSettings] = useState({
    ...emptySubtitleSettings,
  });
  const [generateSubtitles, setGenerateSubtitles] = useState(false);
  const [savingSubtitleSettings, setSavingSubtitleSettings] = useState(false);
  const [subtitleFilePath, setSubtitleFilePath] = useState('');
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [loadingSubtitleFile, setLoadingSubtitleFile] = useState(false);
  const [savingSubtitleFile, setSavingSubtitleFile] = useState(false);
  const [burningSubtitleVideo, setBurningSubtitleVideo] = useState(false);
  const [burnSettings, setBurnSettings] = useState({ ...defaultBurnSettings });
  const [latestBurnedVideoPath, setLatestBurnedVideoPath] = useState('');
  const [testingSubtitleApi, setTestingSubtitleApi] = useState(false);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const [selectedTimelineCueIndex, setSelectedTimelineCueIndex] = useState(-1);
  const [showVideoInfoDetails, setShowVideoInfoDetails] = useState(false);
  const [showWebdavDetails, setShowWebdavDetails] = useState(false);
  const [showVideoActionsMenu, setShowVideoActionsMenu] = useState(false);
  const [mobileStep, setMobileStep] = useState<'select' | 'edit' | 'style' | 'export'>('select');
  const [mobileEditorTab, setMobileEditorTab] = useState<'timing' | 'text' | 'position'>('timing');
  const [selectedCueIndex, setSelectedCueIndex] = useState(-1);
  const [enablePreviewSubtitleEdit, setEnablePreviewSubtitleEdit] = useState(false);
  const [draggingPreviewSubtitle, setDraggingPreviewSubtitle] = useState(false);
  const [previewFrame, setPreviewFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const dragPointerOffsetRef = useRef({ x: 0, y: 0 });
  const dragAnimationFrameRef = useRef<number | null>(null);
  const dragPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath),
    [files, selectedPath]
  );
  const previewUrl = selectedPath ? bridge.getMediaUrl(selectedPath, selectedFile?.mtime || videoInfo?.size || 0) : '';
  const videoDuration = videoInfo?.duration || 0;
  const isFileManagerMode = mode === 'file-manager';
  const isSubtitleWorkshopMobileMode = mode === 'subtitle-workshop-mobile';
  const isSubtitleWorkshopMode = mode !== 'file-manager';
  const normalizeFfmpegPresets = (presets: string[]) => {
    const merged = Array.from(
      new Set([defaultArgs, ...presets.map((item) => item.trim()).filter(Boolean)])
    );
    return merged.slice(0, 20);
  };

  const persistFfmpegPresets = (presets: string[]) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ffmpegPresetStorageKey, JSON.stringify(presets));
  };
  const activeSubtitleIndex = useMemo(
    () =>
      subtitleCues.findIndex((cue) => {
        const start = parseSubtitleTimestampToSeconds(cue.start);
        const end = parseSubtitleTimestampToSeconds(cue.end);
        return currentPlaybackTime >= start && currentPlaybackTime <= end;
      }),
    [currentPlaybackTime, subtitleCues]
  );
  const subtitleTimelineCues = useMemo(
    () =>
      subtitleCues
        .map((cue, index) => {
          const start = parseSubtitleTimestampToSeconds(cue.start);
          const end = parseSubtitleTimestampToSeconds(cue.end);
          return { cue, index, start, end, duration: Math.max(end - start, 0) };
        })
        .filter((item) => videoDuration > 0 && item.end >= item.start),
    [subtitleCues, videoDuration]
  );
  const editableTimelineCueIndex = useMemo(() => {
    if (isSubtitleWorkshopMobileMode && selectedCueIndex >= 0 && selectedCueIndex < subtitleCues.length) {
      return selectedCueIndex;
    }
    if (selectedTimelineCueIndex >= 0) return selectedTimelineCueIndex;
    if (activeSubtitleIndex >= 0) return activeSubtitleIndex;
    return -1;
  }, [activeSubtitleIndex, isSubtitleWorkshopMobileMode, selectedCueIndex, selectedTimelineCueIndex, subtitleCues.length]);
  const editableTimelineCue =
    editableTimelineCueIndex >= 0 ? subtitleCues[editableTimelineCueIndex] : null;
  const previewEditableCueIndex =
    activeSubtitleIndex >= 0 ? activeSubtitleIndex : editableTimelineCueIndex;
  const previewEditableCue =
    previewEditableCueIndex >= 0 ? subtitleCues[previewEditableCueIndex] : null;
  const mobileFocusedCueIndex = editableTimelineCueIndex;
  const mobileFocusedCue = mobileFocusedCueIndex >= 0 ? subtitleCues[mobileFocusedCueIndex] : null;

  const previewPositionX = Math.min(100, Math.max(0, burnSettings.positionX));
  const previewPositionY = Math.min(100, Math.max(0, burnSettings.positionY));
  const nativeVideoWidth = Math.max(videoRef.current?.videoWidth || videoInfo?.width || 0, 1);
  const nativeVideoHeight = Math.max(videoRef.current?.videoHeight || videoInfo?.height || 0, 1);
  const previewScaleX = previewFrame.width > 0 ? previewFrame.width / nativeVideoWidth : 1;
  const previewScaleY = previewFrame.height > 0 ? previewFrame.height / nativeVideoHeight : 1;
  const previewScale = Math.min(previewScaleX || 1, previewScaleY || 1);
  const previewFontSize = Math.max(10, burnSettings.fontSize);
  const previewOutline = Math.max(0, burnSettings.outline);
  const previewShadow = Math.max(0, burnSettings.shadow);
  const preciseSubtitleBoxWidth = Math.round(nativeVideoWidth * 0.92);
  const previewCanvasStyle = {
    left: `${previewFrame.left}px`,
    top: `${previewFrame.top}px`,
    width: `${nativeVideoWidth}px`,
    height: `${nativeVideoHeight}px`,
    transform: `scale(${previewScale})`,
    transformOrigin: 'top left',
  } as const;
  const alignedSubtitleStyle = (() => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      width: '92%',
      maxWidth: '92%',
    };
    const isTop = burnSettings.alignment === 7 || burnSettings.alignment === 8 || burnSettings.alignment === 9;
    if (burnSettings.alignment === 1 || burnSettings.alignment === 7) {
      baseStyle.left = '4%';
    } else if (burnSettings.alignment === 3 || burnSettings.alignment === 9) {
      baseStyle.right = '4%';
    } else {
      baseStyle.left = '50%';
      baseStyle.transform = 'translateX(-50%)';
    }
    if (isTop) {
      baseStyle.top = `${burnSettings.marginV}px`;
    } else {
      baseStyle.bottom = `${burnSettings.marginV}px`;
    }
    return baseStyle;
  })();

  const overlayTextAlign = burnSettings.alignment === 1 || burnSettings.alignment === 7
    ? 'left'
    : burnSettings.alignment === 3 || burnSettings.alignment === 9
      ? 'right'
      : 'center';
  const overlayTextShadow = [
    previewOutline > 0 ? `0 0 ${previewOutline + 1}px ${burnSettings.outlineColor}` : '',
    previewShadow > 0 ? `0 ${previewShadow}px ${previewShadow + 2}px rgba(0,0,0,0.5)` : '',
  ].filter(Boolean).join(', ');
  const previewTextStyle: React.CSSProperties = {
    fontFamily: burnSettings.fontName,
    fontSize: `${previewFontSize}px`,
    color: burnSettings.primaryColor,
    textAlign: overlayTextAlign as 'left' | 'center' | 'right',
    lineHeight: 1.45,
    textShadow: overlayTextShadow || undefined,
    WebkitTextStroke: previewOutline > 0 ? `${previewOutline}px ${burnSettings.outlineColor}` : undefined,
    paintOrder: 'stroke fill',
  };

  const getRenderedVideoRect = useCallback(() => {
    const stage = previewStageRef.current;
    const video = videoRef.current;
    if (!stage) return null;

    const stageRect = stage.getBoundingClientRect();
    const videoRect = video?.getBoundingClientRect();
    const nativeWidth = video?.videoWidth || videoInfo?.width || 0;
    const nativeHeight = video?.videoHeight || videoInfo?.height || 0;

    if (
      !videoRect ||
      nativeWidth <= 0 ||
      nativeHeight <= 0 ||
      videoRect.width <= 0 ||
      videoRect.height <= 0
    ) {
      return stageRect;
    }

    const boxRatio = videoRect.width / videoRect.height;
    const videoRatio = nativeWidth / nativeHeight;

    if (boxRatio > videoRatio) {
      const height = videoRect.height;
      const width = height * videoRatio;
      const left = videoRect.left + (videoRect.width - width) / 2;
      return { left, top: videoRect.top, width, height };
    }

    const width = videoRect.width;
    const height = width / videoRatio;
    const top = videoRect.top + (videoRect.height - height) / 2;
    return { left: videoRect.left, top, width, height };
  }, [videoInfo?.height, videoInfo?.width]);

  const syncPreviewFrame = useCallback(() => {
    const stage = previewStageRef.current;
    const renderedRect = getRenderedVideoRect();
    if (!stage || !renderedRect) return;
    const stageRect = stage.getBoundingClientRect();
    setPreviewFrame({
      left: renderedRect.left - stageRect.left,
      top: renderedRect.top - stageRect.top,
      width: renderedRect.width,
      height: renderedRect.height,
    });
  }, [getRenderedVideoRect]);

  const getWebDAVPayload = () => ({
    webdav_url: webdavSettings.webdavUrl.trim(),
    webdav_username: webdavSettings.webdavUsername.trim(),
    webdav_password: webdavSettings.webdavPassword,
    webdav_base_path: webdavSettings.webdavBasePath.trim(),
  });

  const loadFiles = async (keepSelection = true) => {
    setLoading(true);
    try {
      const list = await bridge.listVideoFiles();
      setFiles(list);
      if (list.length === 0) {
        setSelectedPath('');
        setVideoInfo(null);
      } else if (!keepSelection || !list.some((item) => item.path === selectedPath)) {
        setSelectedPath(list[0].path);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取视频列表失败');
    } finally {
      setLoading(false);
    }
  };

  const loadLocalEntries = async (path = localBrowsePath) => {
    setLoadingLocalEntries(true);
    try {
      const result = await bridge.listLocalEntries(path);
      if (result.success) {
        setLocalBrowsePath(path);
        setLocalEntries(result.entries);
        setSelectedLocalEntryPath('');
        setSelectedLocalEntryName('');
        setSelectedLocalEntryIsDir(false);
        setRenameLocalName('');
      } else {
        toast.error(result.error || '读取本地目录失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取本地目录失败');
    } finally {
      setLoadingLocalEntries(false);
    }
  };

  const loadVideoInfo = async (filePath: string) => {
    try {
      const info = await bridge.getVideoInfo(filePath);
      setVideoInfo(info);
    } catch (err) {
      setVideoInfo(null);
      logger.error(
        `获取视频信息失败: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'file-manager'
      );
    }
  };

  const loadSubtitleFile = async (filePath: string) => {
    if (!filePath.trim()) {
      setSubtitleCues([]);
      return;
    }

    setLoadingSubtitleFile(true);
    try {
      const result = await bridge.readSubtitleFile(filePath.trim());
      if (result.success) {
        setSubtitleFilePath(result.file_path || filePath.trim());
        setSubtitleCues(normalizeSubtitleCues(result.cues));
      } else {
        toast.error(result.error || '读取字幕失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取字幕失败');
      setSubtitleCues([]);
    } finally {
      setLoadingSubtitleFile(false);
    }
  };

  const loadWebDAVSettings = async () => {
    try {
      const settings = await bridge.getSettings();
      setWebdavSettings({
        webdavEnabled: settings.webdavEnabled,
        webdavUrl: settings.webdavUrl,
        webdavUsername: settings.webdavUsername,
        webdavPassword: settings.webdavPassword,
        webdavBasePath: settings.webdavBasePath,
        webdavUploadDownloads: settings.webdavUploadDownloads,
        webdavUploadTransformed: settings.webdavUploadTransformed,
      });
      setSubtitleSettings({
        subtitleLanguage: settings.subtitleLanguage || emptySubtitleSettings.subtitleLanguage,
        subtitleMode: settings.subtitleMode || emptySubtitleSettings.subtitleMode,
        subtitlePrompt:
          settings.subtitlePrompt === legacyDefaultSubtitlePrompt
            ? ''
            : settings.subtitlePrompt || emptySubtitleSettings.subtitlePrompt,
        subtitleLocalWhisperUrl: settings.subtitleLocalWhisperUrl,
        subtitleLocalModel: settings.subtitleLocalModel,
        subtitleWordTimestamps: settings.subtitleWordTimestamps,
        subtitleAutoGenerateOnUpload: settings.subtitleAutoGenerateOnUpload,
        subtitleAutoBurnAfterGenerate: settings.subtitleAutoBurnAfterGenerate,
      });
    } catch {
      setWebdavSettings({ ...emptyWebDAVSettings });
      setSubtitleSettings({ ...emptySubtitleSettings });
    }
  };

  const saveWebDAVSettings = async () => {
    setSavingWebDAV(true);
    try {
      await bridge.saveSettings(webdavSettings as Partial<AppSettings>);
      toast.success('WebDAV 配置已保存');
      logger.success('WebDAV 配置已保存', undefined, 'webdav');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'WebDAV 配置保存失败');
    } finally {
      setSavingWebDAV(false);
    }
  };

  const saveSubtitleSettings = async () => {
    setSavingSubtitleSettings(true);
    try {
      await bridge.saveSettings(subtitleSettings as Partial<AppSettings>);
      toast.success('本地 Whisper 配置已保存');
      logger.success('本地 Whisper 配置已保存', undefined, 'transform');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '本地 Whisper 配置保存失败');
    } finally {
      setSavingSubtitleSettings(false);
    }
  };

  const testWebDAV = async () => {
    setTestingWebDAV(true);
    try {
      const result = await bridge.testWebDAV(getWebDAVPayload());
      if (result.success) {
        toast.success('WebDAV 测试连接成功');
        logger.success('WebDAV 测试连接成功', undefined, 'webdav');
      } else {
        toast.error(result.error || 'WebDAV 测试连接失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'WebDAV 测试连接失败');
    } finally {
      setTestingWebDAV(false);
    }
  };

  const listWebDAVDirectories = async (remoteDir = '') => {
    setListingWebDAV(true);
    try {
      const result = await bridge.listWebDAVDirectories({
        ...getWebDAVPayload(),
        remote_dir: remoteDir,
      });
      if (result.success) {
        setWebdavDirectories(result.entries);
        setSelectedRemoteDir(remoteDir);
        setSelectedRemoteEntryPath('');
        setSelectedRemoteEntryName('');
        setSelectedRemoteEntryIsDir(false);
        setRenameRemoteName('');
      } else {
        toast.error(result.error || '读取 WebDAV 目录失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取 WebDAV 目录失败');
    } finally {
      setListingWebDAV(false);
    }
  };

  const handleTransform = async () => {
    if (!selectedPath) {
      toast.error('请先选择一个视频');
      return;
    }

    setTransforming(true);
    try {
      logger.info(`开始转码: ${selectedPath}`, undefined, 'transform');
      const result = await bridge.transformVideo(selectedPath, ffmpegArgs, {
        generate_subtitles: generateSubtitles,
        auto_burn_subtitles: subtitleSettings.subtitleAutoBurnAfterGenerate,
        subtitle_language: subtitleSettings.subtitleLanguage.trim() || undefined,
        subtitle_mode: subtitleSettings.subtitleMode,
        subtitle_prompt: subtitleSettings.subtitlePrompt.trim() || undefined,
      });
      if (result.success && result.output_path) {
        const extras = [
          result.subtitle_path ? `字幕：${result.subtitle_path}` : '',
          result.subtitle_wav_path ? `音轨：${result.subtitle_wav_path}` : '',
          result.burned_video_path ? `烧录：${result.burned_video_path}` : '',
        ].filter(Boolean).join('，');
        const extraMessage = extras ? `，${extras}` : '';
        toast.success(`转码完成：${result.output_path}${extraMessage}`);
        logger.success(`转码完成: ${result.output_path}${extraMessage}`, undefined, 'transform');
        setLatestBurnedVideoPath(result.burned_video_path || '');
        await loadFiles(false);
      } else {
        toast.error(result.error || '转码失败');
        logger.error(`转码失败: ${result.error || '未知错误'}`, undefined, 'transform');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '转码失败');
      logger.error(
        err instanceof Error ? err.message : '转码失败',
        undefined,
        'transform'
      );
    } finally {
      setTransforming(false);
    }
  };

  const handleCopyToLocal = async () => {
    if (!selectedPath || !copyTargetDir.trim()) {
      toast.error('请先选择视频并填写本地目标目录');
      return;
    }
    setCopyingLocal(true);
    try {
      const result = await bridge.copyToLocal(selectedPath, copyTargetDir.trim());
      if (result.success) {
        toast.success(`已复制到 ${result.output_path}`);
        logger.success(`文件已复制到本地目录: ${result.output_path}`, undefined, 'file-manager');
      } else {
        toast.error(result.error || '复制失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '复制失败');
    } finally {
      setCopyingLocal(false);
    }
  };

  const handleGenerateSubtitlesOnly = async () => {
    if (!selectedPath) {
      toast.error('请先选择一个视频');
      return;
    }

    setGeneratingSubtitlesOnly(true);
    try {
      logger.info(`开始单独生成字幕: ${selectedPath}`, undefined, 'transform');
      const result = await bridge.generateSubtitles(selectedPath, {
        subtitle_language: subtitleSettings.subtitleLanguage.trim() || undefined,
        subtitle_mode: subtitleSettings.subtitleMode,
        subtitle_prompt: subtitleSettings.subtitlePrompt.trim() || undefined,
      });
      if (result.success && result.subtitle_path) {
        const extras = [
          result.subtitle_wav_path ? `音轨：${result.subtitle_wav_path}` : '',
          result.burned_video_path ? `烧录：${result.burned_video_path}` : '',
        ].filter(Boolean).join('，');
        const extraMessage = extras ? `，${extras}` : '';
        toast.success(`字幕生成完成：${result.subtitle_path}${extraMessage}`);
        logger.success(`字幕生成完成: ${result.subtitle_path}`, undefined, 'transform');
        setSubtitleFilePath(result.subtitle_path);
        setLatestBurnedVideoPath(result.burned_video_path || '');
        await loadSubtitleFile(result.subtitle_path);
        await loadFiles(false);
      } else {
        toast.error(result.error || '字幕生成失败');
        logger.error(`字幕生成失败: ${result.error || '未知错误'}`, undefined, 'transform');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '字幕生成失败');
      logger.error(
        err instanceof Error ? err.message : '字幕生成失败',
        undefined,
        'transform'
      );
    } finally {
      setGeneratingSubtitlesOnly(false);
    }
  };

  const handleLoadSubtitleEditor = async () => {
    const targetPath = subtitleFilePath.trim() || buildSubtitlePath(selectedPath);
    setSubtitleFilePath(targetPath);
    await loadSubtitleFile(targetPath);
  };

  const handleSaveSubtitleFile = async () => {
    const targetPath = subtitleFilePath.trim();
    if (!targetPath) {
      toast.error('请先填写字幕文件路径');
      return;
    }

    setSavingSubtitleFile(true);
    try {
      const normalizedCues = subtitleCues.map((cue, index) => ({
        ...cue,
        index: index + 1,
      }));
      const result = await bridge.saveSubtitleFile(targetPath, normalizedCues);
      if (result.success) {
        setSubtitleCues(normalizeSubtitleCues(result.cues));
        toast.success(`字幕已保存：${result.file_path}`);
        logger.success(`字幕已保存: ${result.file_path}`, undefined, 'transform');
      } else {
        toast.error(result.error || '保存字幕失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存字幕失败');
    } finally {
      setSavingSubtitleFile(false);
    }
  };

  const handleAddSubtitleCue = () => {
    setSubtitleCues((prev) => [
      ...prev,
      {
        index: prev.length + 1,
        start: '00:00:00,000',
        end: '00:00:03,000',
        text: '',
      },
    ]);
  };

  const updateSubtitleCue = (
    index: number,
    field: keyof SubtitleCue,
    value: string | number
  ) => {
    setSubtitleCues((prev) =>
      prev.map((cue, cueIndex) =>
        cueIndex === index ? { ...cue, [field]: value } : cue
      )
    );
  };

  const removeSubtitleCue = (index: number) => {
    setSubtitleCues((prev) =>
      prev
        .filter((_, cueIndex) => cueIndex !== index)
        .map((cue, cueIndex) => ({ ...cue, index: cueIndex + 1 }))
    );
  };

  const handleBurnSubtitleVideo = async () => {
    if (!selectedPath) {
      toast.error('请先选择一个视频');
      return;
    }
    if (!subtitleFilePath.trim()) {
      toast.error('请先填写并保存字幕文件路径');
      return;
    }

    setBurningSubtitleVideo(true);
    try {
      const result = await bridge.burnSubtitleFile(selectedPath, subtitleFilePath.trim(), {
        font_name: burnSettings.fontName.trim() || defaultBurnSettings.fontName,
        font_size: burnSettings.fontSize,
        margin_v: burnSettings.marginV,
        outline: burnSettings.outline,
        shadow: burnSettings.shadow,
        primary_color: burnSettings.primaryColor,
        outline_color: burnSettings.outlineColor,
        alignment: burnSettings.alignment,
        use_precise_position: burnSettings.usePrecisePosition,
        position_x: burnSettings.positionX,
        position_y: burnSettings.positionY,
      });
      if (result.success && result.output_path) {
        toast.success(`内嵌字幕视频已生成：${result.output_path}`);
        logger.success(`内嵌字幕视频已生成: ${result.output_path}`, undefined, 'transform');
        setLatestBurnedVideoPath(result.output_path);
        await loadFiles(false);
      } else {
        toast.error(result.error || '内嵌字幕失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '内嵌字幕失败');
    } finally {
      setBurningSubtitleVideo(false);
    }
  };

  const handleJumpToCue = (cue: SubtitleCue) => {
    const targetTime = parseSubtitleTimestampToSeconds(cue.start);
    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
      videoRef.current.play().catch(() => undefined);
    }
    setCurrentPlaybackTime(targetTime);
  };

  const updateBurnPositionFromPointer = (clientX: number, clientY: number) => {
    const rect = getRenderedVideoRect();
    if (!rect) {
      return;
    }
    const x = Math.min(rect.width, Math.max(0, clientX - dragPointerOffsetRef.current.x - rect.left));
    const y = Math.min(rect.height, Math.max(0, clientY - dragPointerOffsetRef.current.y - rect.top));
    const isTop = y < rect.height / 2;
    const horizontalGroup = x < rect.width / 3 ? 'left' : x > (rect.width * 2) / 3 ? 'right' : 'center';

    const alignment = isTop
      ? (horizontalGroup === 'left' ? 7 : horizontalGroup === 'right' ? 9 : 8)
      : (horizontalGroup === 'left' ? 1 : horizontalGroup === 'right' ? 3 : 2);
    const nativeHeight = Math.max(videoRef.current?.videoHeight || videoInfo?.height || 0, 1);
    const marginV = Math.round((isTop ? y : rect.height - y) * (nativeHeight / Math.max(rect.height, 1)));

    setBurnSettings((prev) => ({
      ...prev,
      alignment: prev.usePrecisePosition ? prev.alignment : alignment,
      marginV: prev.usePrecisePosition ? prev.marginV : marginV,
      positionX: Math.min(100, Math.max(0, (x / Math.max(rect.width, 1)) * 100)),
      positionY: Math.min(100, Math.max(0, (y / Math.max(rect.height, 1)) * 100)),
    }));
  };

  const handlePreviewSubtitleDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!previewEditableCue) {
      return;
    }
    const rect = getRenderedVideoRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const currentCenterX = rect.left + (previewPositionX / 100) * rect.width;
    const currentCenterY = rect.top + (previewPositionY / 100) * rect.height;
    dragPointerOffsetRef.current = {
      x: event.clientX - currentCenterX,
      y: event.clientY - currentCenterY,
    };
    setDraggingPreviewSubtitle(true);
    updateBurnPositionFromPointer(event.clientX, event.clientY);
  };

  const flushDragPointer = () => {
    dragAnimationFrameRef.current = null;
    const pointer = dragPointerRef.current;
    if (!pointer) {
      return;
    }
    updateBurnPositionFromPointer(pointer.clientX, pointer.clientY);
  };

  const handleSavePreviewSubtitlePosition = () => {
    toast.success('当前位置已同步到导出参数');
  };

  const formatSecondsToSubtitleTimestamp = (value: number) => {
    const totalSeconds = Math.max(0, value);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
    const milliseconds = String(Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000)).padStart(3, '0').slice(0, 3);
    return `${hours}:${minutes}:${seconds},${milliseconds}`;
  };

  const shiftCueBoundary = (index: number, field: 'start' | 'end', deltaSeconds: number) => {
    const cue = subtitleCues[index];
    if (!cue) {
      return;
    }
    const currentSeconds = parseSubtitleTimestampToSeconds(cue[field]);
    updateSubtitleCue(index, field, formatSecondsToSubtitleTimestamp(currentSeconds + deltaSeconds));
  };

  const setCueBoundaryToCurrentTime = (index: number, field: 'start' | 'end') => {
    updateSubtitleCue(index, field, formatSecondsToSubtitleTimestamp(currentPlaybackTime));
  };

  const handleSelectMobileCue = (index: number) => {
    setSelectedCueIndex(index);
    setSelectedTimelineCueIndex(index);
    setMobileStep('edit');
  };

  const goToAdjacentCue = (direction: -1 | 1) => {
    if (subtitleCues.length === 0) {
      return;
    }
    const baseIndex = mobileFocusedCueIndex >= 0 ? mobileFocusedCueIndex : 0;
    const nextIndex = Math.min(subtitleCues.length - 1, Math.max(0, baseIndex + direction));
    handleSelectMobileCue(nextIndex);
    const nextCue = subtitleCues[nextIndex];
    if (nextCue) {
      handleJumpToCue(nextCue);
    }
  };

  const mobileSteps = [
    { key: 'select', label: '选片' },
    { key: 'edit', label: '字幕' },
    { key: 'style', label: '样式' },
    { key: 'export', label: '导出' },
  ] as const;

  const mobileEditorTabs = [
    { key: 'timing', label: '时间' },
    { key: 'text', label: '文本' },
    { key: 'position', label: '位置' },
  ] as const;

  const handleTestSubtitleApi = async () => {
    setTestingSubtitleApi(true);
    try {
      await bridge.saveSettings(subtitleSettings as Partial<AppSettings>);
      const result = await bridge.testSubtitleApi();
      if (result.success) {
        toast.success(result.detail || '本地 Whisper 测试成功');
      } else {
        toast.error(result.detail || '本地 Whisper 测试失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '本地 Whisper 测试失败');
    } finally {
      setTestingSubtitleApi(false);
    }
  };

  const handleDownloadSubtitle = (format: 'srt' | 'json') => {
    if (subtitleCues.length === 0) {
      toast.error('当前没有可下载的字幕内容');
      return;
    }
    const baseName = (selectedFile?.name || 'subtitle').replace(/\.[^.]+$/, '');
    if (format === 'srt') {
      downloadBlob(`${baseName}.srt`, buildSrtFromCues(subtitleCues), 'text/plain;charset=utf-8');
      return;
    }
    downloadBlob(
      `${baseName}.json`,
      JSON.stringify(
        subtitleCues.map((cue, index) => ({ ...cue, index: index + 1 })),
        null,
        2
      ),
      'application/json'
    );
  };

  const handleDownloadVideo = (filePath: string) => {
    if (!filePath) {
      toast.error('没有可下载的视频文件');
      return;
    }
    const filename = filePath.split(/[/\\]/).pop() || 'video.mp4';
    const a = document.createElement('a');
    a.href = bridge.getMediaUrl(filePath);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleSaveCurrentFfmpegPreset = () => {
    const value = ffmpegArgs.trim();
    if (!value) {
      toast.error('命令为空，不能保存');
      return;
    }
    const nextPresets = normalizeFfmpegPresets([value, ...ffmpegPresets]);
    setFfmpegPresets(nextPresets);
    setSelectedFfmpegPreset(value);
    persistFfmpegPresets(nextPresets);
    toast.success('已保存到命令预设');
  };

  const handleDeleteSelectedVideo = async () => {
    if (!selectedPath) {
      toast.error('请先选择视频');
      return;
    }
    if (!window.confirm(`确认删除当前视频？\n${selectedPath}`)) {
      return;
    }
    try {
      const result = await bridge.deleteLocalPath(selectedPath);
      if (result.success) {
        toast.success('视频已删除');
        setShowVideoActionsMenu(false);
        await loadFiles(false);
      } else {
        toast.error(result.error || '删除失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleCreateLocalFolder = async () => {
    if (!newLocalFolderName.trim()) {
      toast.error('请先输入本地新目录名');
      return;
    }
    setCreatingLocalFolder(true);
    try {
      const result = await bridge.createLocalDirectory(localBrowsePath, newLocalFolderName.trim());
      if (result.success) {
        toast.success(`已创建目录: ${result.path}`);
        setNewLocalFolderName('');
        await loadLocalEntries(localBrowsePath);
      } else {
        toast.error(result.error || '创建本地目录失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建本地目录失败');
    } finally {
      setCreatingLocalFolder(false);
    }
  };

  const handleRenameLocal = async () => {
    if (!selectedLocalEntryPath || !renameLocalName.trim()) {
      toast.error('请先选择本地文件或目录，并输入新名称');
      return;
    }
    setRenamingLocal(true);
    try {
      const result = await bridge.renameLocalPath(selectedLocalEntryPath, renameLocalName.trim());
      if (result.success) {
        toast.success(`已重命名为: ${renameLocalName.trim()}`);
        await loadLocalEntries(localBrowsePath);
      } else {
        toast.error(result.error || '本地重命名失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '本地重命名失败');
    } finally {
      setRenamingLocal(false);
    }
  };

  const handleDeleteLocal = async () => {
    if (!selectedLocalEntryPath) {
      toast.error('请先选择本地文件或目录');
      return;
    }
    if (!window.confirm(`确认删除本地项目？\n${selectedLocalEntryPath}`)) {
      return;
    }
    setDeletingLocal(true);
    try {
      const result = await bridge.deleteLocalPath(selectedLocalEntryPath);
      if (result.success) {
        toast.success('本地项目已删除');
        if (selectedLocalDir === selectedLocalEntryPath) {
          setSelectedLocalDir('');
          setCopyTargetDir('');
        }
        await loadLocalEntries(localBrowsePath);
      } else {
        toast.error(result.error || '本地删除失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '本地删除失败');
    } finally {
      setDeletingLocal(false);
    }
  };

  const handleUploadToWebDAV = async () => {
    if (!selectedPath) {
      toast.error('请先选择视频');
      return;
    }
    if (!webdavSettings.webdavUrl.trim()) {
      toast.error('请先填写 WebDAV 地址');
      return;
    }
    setUploadingWebDAV(true);
    try {
      const result = await bridge.uploadToWebDAV(
        selectedPath,
        'download',
        selectedRemoteDir,
        getWebDAVPayload()
      );
      if (result.success) {
        const extras = [
          result.subtitle_path ? `字幕：${result.subtitle_path}` : '',
          result.burned_video_path ? `烧录：${result.burned_video_path}` : '',
        ].filter(Boolean).join('，');
        const extraMessage = extras ? `，${extras}` : '';
        toast.success(`已上传到 WebDAV: ${result.remote_path}${extraMessage}`);
        logger.success(`文件已上传到 WebDAV: ${result.remote_path}${extraMessage}`, undefined, 'webdav');
      } else {
        toast.error(result.error || '上传 WebDAV 失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传 WebDAV 失败');
    } finally {
      setUploadingWebDAV(false);
    }
  };

  const handleCreateRemoteFolder = async () => {
    if (!newRemoteFolderName.trim()) {
      toast.error('请先输入远程新目录名');
      return;
    }
    setCreatingRemoteFolder(true);
    try {
      const result = await bridge.createWebDAVDirectory({
        ...getWebDAVPayload(),
        target_dir: selectedRemoteDir,
        name: newRemoteFolderName.trim(),
      });
      if (result.success) {
        toast.success(`远程目录已创建: ${newRemoteFolderName.trim()}`);
        setNewRemoteFolderName('');
        await listWebDAVDirectories(selectedRemoteDir);
      } else {
        toast.error(result.error || '创建远程目录失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建远程目录失败');
    } finally {
      setCreatingRemoteFolder(false);
    }
  };

  const handleRenameRemote = async () => {
    if (!selectedRemoteEntryPath || !renameRemoteName.trim()) {
      toast.error('请先选择远程文件或目录，并输入新名称');
      return;
    }
    setRenamingRemote(true);
    try {
      const result = await bridge.renameWebDAVPath({
        ...getWebDAVPayload(),
        path: selectedRemoteEntryPath,
        new_name: renameRemoteName.trim(),
      });
      if (result.success) {
        toast.success(`远程已重命名为: ${renameRemoteName.trim()}`);
        await listWebDAVDirectories(selectedRemoteDir);
      } else {
        toast.error(result.error || '远程重命名失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '远程重命名失败');
    } finally {
      setRenamingRemote(false);
    }
  };

  const handleDeleteRemote = async () => {
    if (!selectedRemoteEntryPath) {
      toast.error('请先选择远程文件或目录');
      return;
    }
    if (!window.confirm(`确认删除远程项目？\n${selectedRemoteEntryPath}`)) {
      return;
    }
    setDeletingRemote(true);
    try {
      const targetDirAfterDelete =
        selectedRemoteDir === selectedRemoteEntryPath
          ? selectedRemoteDir.split('/').slice(0, -1).join('/')
          : selectedRemoteDir;
      const result = await bridge.deleteWebDAVPath({
        ...getWebDAVPayload(),
        path: selectedRemoteEntryPath,
      });
      if (result.success) {
        toast.success('远程项目已删除');
        setSelectedRemoteDir(targetDirAfterDelete);
        await listWebDAVDirectories(targetDirAfterDelete);
      } else {
        toast.error(result.error || '远程删除失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '远程删除失败');
    } finally {
      setDeletingRemote(false);
    }
  };

  useEffect(() => {
    loadFiles(false);
    loadWebDAVSettings();
    loadLocalEntries('/app/download');

    if (typeof window !== 'undefined') {
      try {
        const rawPresets = window.localStorage.getItem(ffmpegPresetStorageKey);
        if (rawPresets) {
          const parsed = JSON.parse(rawPresets);
          if (Array.isArray(parsed)) {
            const normalized = normalizeFfmpegPresets(parsed);
            setFfmpegPresets(normalized);
            setSelectedFfmpegPreset(defaultArgs);
            persistFfmpegPresets(normalized);
          }
        }
      } catch {
        setFfmpegPresets([defaultArgs]);
        setSelectedFfmpegPreset(defaultArgs);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedPath) {
      loadVideoInfo(selectedPath);
      setSubtitleFilePath(buildSubtitlePath(selectedPath));
      setSubtitleCues([]);
      setCurrentPlaybackTime(0);
      setSelectedTimelineCueIndex(-1);
      setLatestBurnedVideoPath('');
    } else {
      setVideoInfo(null);
      setSubtitleFilePath('');
      setSubtitleCues([]);
      setCurrentPlaybackTime(0);
      setSelectedTimelineCueIndex(-1);
      setLatestBurnedVideoPath('');
    }
    setShowVideoActionsMenu(false);
  }, [selectedPath]);

  useEffect(() => {
    const current = ffmpegArgs.trim();
    if (ffmpegPresets.includes(current)) {
      setSelectedFfmpegPreset(current);
    } else {
      setSelectedFfmpegPreset('');
    }
  }, [ffmpegArgs, ffmpegPresets]);

  useEffect(() => {
    if (selectedTimelineCueIndex >= subtitleCues.length) {
      setSelectedTimelineCueIndex(-1);
    }
  }, [subtitleCues.length, selectedTimelineCueIndex]);

  useEffect(() => {
    if (!isSubtitleWorkshopMobileMode) {
      return;
    }
    if (!selectedPath) {
      setMobileStep('select');
      return;
    }
    if (subtitleCues.length === 0) {
      setMobileStep((prev) => (prev === 'select' ? prev : 'select'));
      return;
    }
    setSelectedCueIndex((prev) => {
      if (prev >= 0 && prev < subtitleCues.length) {
        return prev;
      }
      if (activeSubtitleIndex >= 0) {
        return activeSubtitleIndex;
      }
      return 0;
    });
  }, [activeSubtitleIndex, isSubtitleWorkshopMobileMode, selectedPath, subtitleCues.length]);

  useEffect(() => {
    if (!isSubtitleWorkshopMobileMode || subtitleCues.length === 0) {
      return;
    }
    setMobileStep((prev) => (prev === 'select' ? 'edit' : prev));
  }, [isSubtitleWorkshopMobileMode, subtitleCues.length]);

  useEffect(() => {
    syncPreviewFrame();
    const handleResize = () => syncPreviewFrame();
    window.addEventListener('resize', handleResize);
    const stage = previewStageRef.current;
    const observer =
      stage && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => syncPreviewFrame())
        : null;
    if (stage && observer) {
      observer.observe(stage);
    }
    const video = videoRef.current;
    if (video) {
      video.addEventListener('loadedmetadata', handleResize);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      if (video) {
        video.removeEventListener('loadedmetadata', handleResize);
      }
      observer?.disconnect();
    };
  }, [selectedPath, syncPreviewFrame]);

  useEffect(() => {
    if (!draggingPreviewSubtitle) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      dragPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      if (dragAnimationFrameRef.current === null) {
        dragAnimationFrameRef.current = window.requestAnimationFrame(flushDragPointer);
      }
    };

    const handleUp = () => {
      setDraggingPreviewSubtitle(false);
      dragPointerOffsetRef.current = { x: 0, y: 0 };
      dragPointerRef.current = null;
      if (dragAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(dragAnimationFrameRef.current);
        dragAnimationFrameRef.current = null;
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      if (dragAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(dragAnimationFrameRef.current);
        dragAnimationFrameRef.current = null;
      }
    };
  }, [draggingPreviewSubtitle]);

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-[#F8F9FB] p-4 sm:p-6 lg:p-8">
      <div className="mb-6 rounded-[28px] border border-slate-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.16),_transparent_30%),linear-gradient(135deg,_#ffffff_0%,_#f8fafc_48%,_#eef6ff_100%)] p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              {isFileManagerMode ? <FolderOpen className="h-3.5 w-3.5 text-sky-600" /> : <Captions className="h-3.5 w-3.5 text-emerald-600" />}
              {isFileManagerMode ? 'Asset Hub' : isSubtitleWorkshopMobileMode ? 'Mobile Subtitle Lab' : 'Subtitle Workshop'}
            </div>
            <h2 className="text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">
              {isFileManagerMode ? '文件管理' : isSubtitleWorkshopMobileMode ? '字幕工坊移动版' : '字幕工坊'}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              {isFileManagerMode
                ? '以文件流转为中心，集中处理本地目录、预览、复制和 WebDAV 上传，布局更适合批量整理素材。'
                : isSubtitleWorkshopMobileMode
                  ? '为 iPhone 触屏编辑重新整理主路径：先选片，再聚焦字幕时间、文本和位置调整，最后一键保存与导出。'
                  : '以字幕生产为中心，集中处理 Whisper 配置、字幕生成、时间轴编辑和烧录导出，不再和文件管理共用同一页。'}
            </p>
          </div>
          <button
            onClick={() => loadFiles(false)}
            disabled={loading}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            刷新文件
          </button>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">视频文件</div>
            <div className="mt-2 text-3xl font-black text-slate-900">{files.length}</div>
            <div className="mt-1 text-sm text-slate-500">当前可操作的视频素材数</div>
          </div>
          <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">当前文件</div>
            <div className="mt-2 truncate text-lg font-bold text-slate-900">{selectedFile?.name || '未选择'}</div>
            <div className="mt-1 text-sm text-slate-500">{selectedFile ? formatSize(selectedFile.size) : '先从左侧选择一个视频'}</div>
          </div>
          <div className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              {isFileManagerMode ? '同步通道' : isSubtitleWorkshopMobileMode ? '移动流程' : '字幕进度'}
            </div>
            <div className="mt-2 text-lg font-bold text-slate-900">
              {isFileManagerMode
                ? '本地目录 + WebDAV'
                : isSubtitleWorkshopMobileMode
                  ? `${mobileStep === 'select' ? '选片准备中' : mobileStep === 'edit' ? '聚焦字幕编辑' : mobileStep === 'style' ? '样式与位置' : '保存与导出'}`
                  : subtitleCues.length > 0
                    ? `${subtitleCues.length} 条字幕`
                    : '尚未载入字幕'}
            </div>
            <div className="mt-1 text-sm text-slate-500">
              {isFileManagerMode
                ? '目录浏览、上传和远程整理合并到一个工作区'
                : isSubtitleWorkshopMobileMode
                  ? '按 iPhone 主路径拆成选片、字幕、样式、导出四步'
                  : '可直接在时间轴中校对并导出'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-xl font-bold text-gray-800">视频素材</h3>
              <p className="text-sm text-gray-500 mt-1">
                {isFileManagerMode ? '左侧专注做素材筛选和切换。' : '先选中视频，再进入字幕和烧录流程。'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                {files.length} 个文件
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowVideoActionsMenu((prev) => !prev)}
                  disabled={!selectedPath}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 disabled:opacity-50"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                  更多
                </button>
                {showVideoActionsMenu && (
                  <div className="absolute right-0 mt-2 w-40 rounded-xl border border-gray-200 bg-white shadow-lg z-20 overflow-hidden">
                    <button
                      onClick={() => {
                        handleDownloadVideo(selectedPath);
                        setShowVideoActionsMenu(false);
                      }}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                    >
                      下载选中视频
                    </button>
                    <button
                      onClick={handleDeleteSelectedVideo}
                      className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      删除选中视频
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100 lg:max-h-[70vh]">
            {files.length === 0 ? (
              <div className="text-sm text-gray-500 p-4">暂无视频文件，请先下载。</div>
            ) : (
              files.map((file) => (
                <label key={file.path} className="flex items-start justify-between gap-3 p-3 hover:bg-gray-50 cursor-pointer">
                  <div className="flex items-start gap-3 min-w-0">
                    <input
                      type="radio"
                      name="video_file"
                      checked={selectedPath === file.path}
                      onChange={() => setSelectedPath(file.path)}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{file.name}</div>
                      <div className="text-xs text-gray-500 break-all">{file.path}</div>
                      <div className="text-xs text-gray-400 mt-1">{formatDate(file.mtime)}</div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 ml-4 shrink-0">{formatSize(file.size)}</div>
                </label>
              ))
            )}
          </div>
        </section>

        <section className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-4">视频预览</h3>
            {selectedPath ? (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-3">
                  <div
                    ref={previewStageRef}
                    className="relative flex min-h-[240px] items-center justify-center overflow-hidden rounded-2xl bg-black sm:min-h-[320px]"
                  >
                    <video
                      key={previewUrl}
                      ref={videoRef}
                      src={previewUrl}
                      controls
                      onLoadedMetadata={() => syncPreviewFrame()}
                      onTimeUpdate={(e) => setCurrentPlaybackTime(e.currentTarget.currentTime)}
                      className="h-full w-full max-h-[320px] object-contain sm:max-h-[420px] lg:max-h-[520px]"
                    />
                    {isSubtitleWorkshopMode && previewEditableCue && (
                      <div className="absolute inset-0 z-10 pointer-events-none">
                        <div className="absolute pointer-events-none" style={previewCanvasStyle}>
                          <div
                            className="absolute"
                            style={
                              burnSettings.usePrecisePosition
                                ? {
                                    width: `${preciseSubtitleBoxWidth}px`,
                                    maxWidth: `${preciseSubtitleBoxWidth}px`,
                                    left: `${previewPositionX}%`,
                                    top: `${previewPositionY}%`,
                                    transform: 'translate(-50%, -50%)',
                                    pointerEvents: 'auto',
                                  }
                                : {
                                    ...alignedSubtitleStyle,
                                    pointerEvents: 'auto',
                                  }
                            }
                          >
                            <div
                              onPointerDown={handlePreviewSubtitleDragStart}
                              className="absolute left-1/2 inline-flex -translate-x-1/2 touch-none select-none rounded-full border border-white/30 bg-black/45 px-3 py-1 text-xs text-white shadow-sm sm:px-2 sm:py-0.5 sm:text-[11px]"
                              style={{
                                top: `${Math.round(-34 / Math.max(previewScale, 0.25))}px`,
                                fontSize: `${Math.max(12, 11 / Math.max(previewScale, 0.25))}px`,
                              }}
                            >
                              拖动调整位置
                            </div>
                            {enablePreviewSubtitleEdit ? (
                              <textarea
                                value={previewEditableCue.text}
                                onChange={(e) => updateSubtitleCue(previewEditableCueIndex, 'text', e.target.value)}
                                rows={3}
                                className="w-full rounded-xl border border-white/20 bg-black/20 px-3 py-2 focus:outline-none resize-none"
                                style={previewTextStyle}
                              />
                            ) : (
                              <div
                                className="w-full whitespace-pre-line"
                                style={previewTextStyle}
                              >
                                {previewEditableCue.text}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                    {isSubtitleWorkshopMode && !previewEditableCue && (
                      <div className="absolute inset-x-0 bottom-16 z-10 flex justify-center px-6 pointer-events-none">
                        <div className="max-w-[88%] rounded-xl bg-black/60 px-4 py-2 text-sm text-gray-200">
                          当前时刻没有字幕，先读取或生成字幕后可在画面中编辑。
                        </div>
                      </div>
                    )}
                  </div>
                  {isSubtitleWorkshopMode && (
                    <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-800">画面字幕预览与编辑（同步导出样式）</div>
                          <div className="mt-1 text-xs text-gray-500 sm:hidden">手机端可直接拖动字幕标签调整位置，也可用下方 X/Y 精确微调。</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                          <button
                            onClick={() => setEnablePreviewSubtitleEdit((prev) => !prev)}
                            disabled={!previewEditableCue}
                            className={`px-3 py-1.5 rounded-lg text-sm border ${enablePreviewSubtitleEdit ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-200 text-gray-700'} disabled:opacity-50`}
                          >
                            {enablePreviewSubtitleEdit ? '关闭画面编辑' : '开启画面编辑'}
                          </button>
                          <button
                            onClick={handleSavePreviewSubtitlePosition}
                            disabled={!previewEditableCue}
                            className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-700 disabled:opacity-50"
                          >
                            保存位置
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={burnSettings.usePrecisePosition}
                            onChange={(e) =>
                              setBurnSettings((prev) => ({ ...prev, usePrecisePosition: e.target.checked }))
                            }
                          />
                          使用精确坐标（X/Y）
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={burnSettings.positionX}
                          onChange={(e) =>
                            setBurnSettings((prev) => ({
                              ...prev,
                              positionX: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                            }))
                          }
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                          placeholder="X(0-100)"
                          disabled={!burnSettings.usePrecisePosition}
                        />
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={burnSettings.positionY}
                          onChange={(e) =>
                            setBurnSettings((prev) => ({
                              ...prev,
                              positionY: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                            }))
                          }
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                          placeholder="Y(0-100)"
                          disabled={!burnSettings.usePrecisePosition}
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <select
                          value={burnSettings.fontName}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, fontName: e.target.value }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        >
                          {subtitleFontOptions.map((fontName) => (
                            <option key={fontName} value={fontName}>
                              {fontName}
                            </option>
                          ))}
                        </select>
                        <select
                          value={burnSettings.fontSize}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, fontSize: Number(e.target.value) || defaultBurnSettings.fontSize }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        >
                          {subtitleFontSizeOptions.map((fontSize) => (
                            <option key={fontSize} value={fontSize}>
                              {fontSize}px
                            </option>
                          ))}
                        </select>
                        <select
                          value={burnSettings.alignment}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, alignment: Number(e.target.value) }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                          disabled={burnSettings.usePrecisePosition}
                        >
                          {subtitleAlignmentOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={burnSettings.marginV}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, marginV: Number(e.target.value) || defaultBurnSettings.marginV }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                          disabled={burnSettings.usePrecisePosition}
                        >
                          {subtitleMarginVOptions.map((marginV) => (
                            <option key={marginV} value={marginV}>
                              底边距 {marginV}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <select
                          value={burnSettings.outline}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, outline: Number(e.target.value) || defaultBurnSettings.outline }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        >
                          {subtitleOutlineOptions.map((outline) => (
                            <option key={outline} value={outline}>
                              描边 {outline}
                            </option>
                          ))}
                        </select>
                        <select
                          value={burnSettings.shadow}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, shadow: Number(e.target.value) || defaultBurnSettings.shadow }))}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        >
                          {subtitleShadowOptions.map((shadow) => (
                            <option key={shadow} value={shadow}>
                              阴影 {shadow}
                            </option>
                          ))}
                        </select>
                        <input
                          type="color"
                          value={burnSettings.primaryColor}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, primaryColor: e.target.value }))}
                          className="h-10 w-full rounded-lg border border-gray-200 bg-white"
                          title="字幕颜色"
                        />
                        <input
                          type="color"
                          value={burnSettings.outlineColor}
                          onChange={(e) => setBurnSettings((prev) => ({ ...prev, outlineColor: e.target.value }))}
                          className="h-10 w-full rounded-lg border border-gray-200 bg-white"
                          title="描边颜色"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={handleSaveSubtitleFile}
                          disabled={savingSubtitleFile || !subtitleFilePath}
                          className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          保存字幕
                        </button>
                        <button
                          onClick={handleBurnSubtitleVideo}
                          disabled={!selectedPath || !subtitleFilePath || burningSubtitleVideo}
                          className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {burningSubtitleVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                          保存并生成内嵌视频
                        </button>
                        <button
                          onClick={() => handleDownloadSubtitle('srt')}
                          disabled={subtitleCues.length === 0}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 flex items-center gap-2 disabled:opacity-50"
                        >
                          <Download className="w-4 h-4" />
                          下载字幕
                        </button>
                        <button
                          onClick={() => handleDownloadVideo(latestBurnedVideoPath || selectedPath)}
                          disabled={!latestBurnedVideoPath && !selectedPath}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 flex items-center gap-2 disabled:opacity-50"
                        >
                          <Download className="w-4 h-4" />
                          下载视频
                        </button>
                      </div>
                    </div>
                  )}
                  {isSubtitleWorkshopMode ? (
                    isSubtitleWorkshopMobileMode ? (
                      <div className="rounded-2xl border border-gray-200 bg-white p-4">
                        <div className="space-y-4">
                          <div className="flex flex-wrap gap-2">
                            {mobileSteps.map((step) => {
                              const isActive = mobileStep === step.key;
                              return (
                                <button
                                  key={step.key}
                                  onClick={() => setMobileStep(step.key)}
                                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${isActive ? 'bg-slate-900 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}
                                >
                                  {step.label}
                                </button>
                              );
                            })}
                          </div>

                          <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-gray-800">移动版字幕流程</div>
                                <div className="mt-1 text-xs leading-5 text-gray-500">
                                  先读取或生成字幕，再聚焦单条字幕做时间、文本和位置调整，最后保存与导出。
                                </div>
                              </div>
                              <div className="rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-emerald-700">
                                {subtitleCues.length > 0 ? `${subtitleCues.length} 条字幕` : '等待载入'}
                              </div>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-gray-800">字幕文件</div>
                                <div className="mt-1 text-xs text-gray-500">默认按当前视频推断同名 `.srt`，也可手动改路径。</div>
                              </div>
                              <button
                                onClick={handleSaveSubtitleFile}
                                disabled={savingSubtitleFile || !subtitleFilePath}
                                className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                              >
                                {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                保存
                              </button>
                            </div>
                            <input
                              value={subtitleFilePath}
                              onChange={(e) => setSubtitleFilePath(e.target.value)}
                              placeholder="字幕文件路径，例如 transformed/2026/04/19/xxx_tr.srt"
                              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                            />
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <button
                                onClick={handleLoadSubtitleEditor}
                                disabled={!selectedPath || loadingSubtitleFile}
                                className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm disabled:opacity-50"
                              >
                                {loadingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                读取字幕
                              </button>
                              <button
                                onClick={handleGenerateSubtitlesOnly}
                                disabled={!selectedPath || generatingSubtitlesOnly}
                                className="flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm font-medium text-blue-700 disabled:opacity-50"
                              >
                                {generatingSubtitlesOnly ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                                单独生成字幕
                              </button>
                            </div>
                          </div>

                          <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-gray-800">字幕时间条</div>
                                <div className="mt-1 text-xs text-gray-500">
                                  当前播放 {formatDuration(currentPlaybackTime)} / {formatDuration(videoDuration)}
                                </div>
                              </div>
                              {mobileFocusedCue && (
                                <button
                                  onClick={() => handleJumpToCue(mobileFocusedCue)}
                                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700"
                                >
                                  跳到当前条
                                </button>
                              )}
                            </div>
                            <div className="relative h-16 overflow-hidden rounded-xl bg-slate-900">
                              {subtitleTimelineCues.length === 0 ? (
                                <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-slate-400">
                                  暂无字幕时间条，先生成或读取 `.srt`
                                </div>
                              ) : (
                                subtitleTimelineCues.map(({ cue, index, start, duration }) => {
                                  const left = `${(start / videoDuration) * 100}%`;
                                  const width = `${Math.max((duration / videoDuration) * 100, 1)}%`;
                                  const isActive = index === mobileFocusedCueIndex || index === activeSubtitleIndex;
                                  return (
                                    <button
                                      key={`${cue.index}-${index}`}
                                      onClick={() => {
                                        handleSelectMobileCue(index);
                                        handleJumpToCue(cue);
                                      }}
                                      title={`${cue.start} - ${cue.end}\n${cue.text}`}
                                      className={`absolute top-2 h-12 overflow-hidden rounded-md border px-2 text-left ${isActive ? 'border-emerald-200 bg-emerald-400/90 text-slate-900' : 'border-amber-100 bg-amber-300/80 text-slate-900'}`}
                                      style={{ left, width, minWidth: '12px' }}
                                    >
                                      <span className="block truncate text-[11px] font-medium leading-7">{cue.text}</span>
                                    </button>
                                  );
                                })
                              )}
                              {videoDuration > 0 && (
                                <div
                                  className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white/90"
                                  style={{ left: `${(currentPlaybackTime / videoDuration) * 100}%` }}
                                />
                              )}
                            </div>
                            <div className="max-h-44 space-y-2 overflow-auto pr-1">
                              {subtitleCues.length === 0 ? (
                                <div className="rounded-xl border border-dashed border-gray-200 p-3 text-sm text-gray-500">
                                  还没有载入字幕，先读取或生成字幕文件。
                                </div>
                              ) : (
                                subtitleCues.map((cue, index) => {
                                  const isActive = index === mobileFocusedCueIndex;
                                  return (
                                    <button
                                      key={`${cue.index}-${index}`}
                                      onClick={() => {
                                        handleSelectMobileCue(index);
                                        handleJumpToCue(cue);
                                      }}
                                      className={`w-full rounded-xl border px-3 py-3 text-left transition ${isActive ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50/70'}`}
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-semibold text-gray-800">第 {index + 1} 条</div>
                                        <div className="text-[11px] text-gray-500">{cue.start} → {cue.end}</div>
                                      </div>
                                      <div className="mt-1 line-clamp-2 text-sm text-gray-600">{cue.text || '未填写字幕文本'}</div>
                                    </button>
                                  );
                                })
                              )}
                            </div>
                          </div>

                          {mobileFocusedCue ? (
                            <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-base font-bold text-gray-800">第 {mobileFocusedCueIndex + 1} 条字幕</div>
                                  <div className="mt-1 text-xs text-gray-500">围绕当前选中字幕做单条聚焦编辑，更适合触屏操作。</div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => goToAdjacentCue(-1)}
                                    disabled={mobileFocusedCueIndex <= 0}
                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                                  >
                                    上一条
                                  </button>
                                  <button
                                    onClick={() => goToAdjacentCue(1)}
                                    disabled={mobileFocusedCueIndex >= subtitleCues.length - 1}
                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                                  >
                                    下一条
                                  </button>
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-2">
                                {mobileEditorTabs.map((tab) => {
                                  const isActive = mobileEditorTab === tab.key;
                                  return (
                                    <button
                                      key={tab.key}
                                      onClick={() => setMobileEditorTab(tab.key)}
                                      className={`rounded-full px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-slate-900 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}
                                    >
                                      {tab.label}
                                    </button>
                                  );
                                })}
                              </div>

                              {mobileEditorTab === 'timing' && (
                                <div className="space-y-3 rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <input
                                      value={mobileFocusedCue.start}
                                      onChange={(e) => updateSubtitleCue(mobileFocusedCueIndex, 'start', e.target.value)}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      placeholder="开始时间"
                                    />
                                    <input
                                      value={mobileFocusedCue.end}
                                      onChange={(e) => updateSubtitleCue(mobileFocusedCueIndex, 'end', e.target.value)}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      placeholder="结束时间"
                                    />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    {[-0.5, -0.1, 0.1, 0.5].map((delta) => (
                                      <button
                                        key={`start-${delta}`}
                                        onClick={() => shiftCueBoundary(mobileFocusedCueIndex, 'start', delta)}
                                        className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700"
                                      >
                                        开始 {delta > 0 ? '+' : ''}{delta}s
                                      </button>
                                    ))}
                                  </div>
                                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    {[-0.5, -0.1, 0.1, 0.5].map((delta) => (
                                      <button
                                        key={`end-${delta}`}
                                        onClick={() => shiftCueBoundary(mobileFocusedCueIndex, 'end', delta)}
                                        className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700"
                                      >
                                        结束 {delta > 0 ? '+' : ''}{delta}s
                                      </button>
                                    ))}
                                  </div>
                                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    <button
                                      onClick={() => setCueBoundaryToCurrentTime(mobileFocusedCueIndex, 'start')}
                                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700"
                                    >
                                      用当前播放时间设为开始
                                    </button>
                                    <button
                                      onClick={() => setCueBoundaryToCurrentTime(mobileFocusedCueIndex, 'end')}
                                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-700"
                                    >
                                      用当前播放时间设为结束
                                    </button>
                                  </div>
                                </div>
                              )}

                              {mobileEditorTab === 'text' && (
                                <div className="space-y-3 rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                                  <textarea
                                    value={mobileFocusedCue.text}
                                    onChange={(e) => updateSubtitleCue(mobileFocusedCueIndex, 'text', e.target.value)}
                                    rows={5}
                                    placeholder="字幕文本"
                                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                  />
                                  <div className="flex flex-wrap gap-2">
                                    <button
                                      onClick={() => handleJumpToCue(mobileFocusedCue)}
                                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                                    >
                                      跳转到这一条
                                    </button>
                                    <button
                                      onClick={() => removeSubtitleCue(mobileFocusedCueIndex)}
                                      className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600"
                                    >
                                      删除这一条
                                    </button>
                                    <button
                                      onClick={handleAddSubtitleCue}
                                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                                    >
                                      新增字幕
                                    </button>
                                  </div>
                                </div>
                              )}

                              {mobileEditorTab === 'position' && (
                                <div className="space-y-3 rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                                  <div className="text-sm text-gray-600">直接在上方预览里拖动字幕，也可以在这里做精确微调。</div>
                                  <label className="flex items-center gap-2 text-sm text-gray-700">
                                    <input
                                      type="checkbox"
                                      checked={burnSettings.usePrecisePosition}
                                      onChange={(e) =>
                                        setBurnSettings((prev) => ({ ...prev, usePrecisePosition: e.target.checked }))
                                      }
                                    />
                                    使用精确坐标（X/Y）
                                  </label>
                                  <div className="grid grid-cols-2 gap-3">
                                    <input
                                      type="number"
                                      min={0}
                                      max={100}
                                      value={burnSettings.positionX}
                                      onChange={(e) =>
                                        setBurnSettings((prev) => ({
                                          ...prev,
                                          positionX: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                                        }))
                                      }
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      placeholder="X(0-100)"
                                      disabled={!burnSettings.usePrecisePosition}
                                    />
                                    <input
                                      type="number"
                                      min={0}
                                      max={100}
                                      value={burnSettings.positionY}
                                      onChange={(e) =>
                                        setBurnSettings((prev) => ({
                                          ...prev,
                                          positionY: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                                        }))
                                      }
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      placeholder="Y(0-100)"
                                      disabled={!burnSettings.usePrecisePosition}
                                    />
                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <select
                                      value={burnSettings.alignment}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, alignment: Number(e.target.value) }))}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      disabled={burnSettings.usePrecisePosition}
                                    >
                                      {subtitleAlignmentOptions.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      value={burnSettings.marginV}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, marginV: Number(e.target.value) || defaultBurnSettings.marginV }))}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                      disabled={burnSettings.usePrecisePosition}
                                    >
                                      {subtitleMarginVOptions.map((marginV) => (
                                        <option key={marginV} value={marginV}>
                                          底边距 {marginV}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    <select
                                      value={burnSettings.fontSize}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, fontSize: Number(e.target.value) || defaultBurnSettings.fontSize }))}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                    >
                                      {subtitleFontSizeOptions.map((fontSize) => (
                                        <option key={fontSize} value={fontSize}>
                                          {fontSize}px
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      type="color"
                                      value={burnSettings.primaryColor}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, primaryColor: e.target.value }))}
                                      className="h-12 w-full rounded-xl border border-gray-200 bg-white"
                                      title="字幕颜色"
                                    />
                                    <select
                                      value={burnSettings.outline}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, outline: Number(e.target.value) || defaultBurnSettings.outline }))}
                                      className="rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm focus:outline-none"
                                    >
                                      {subtitleOutlineOptions.map((outline) => (
                                        <option key={outline} value={outline}>
                                          描边 {outline}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      type="color"
                                      value={burnSettings.outlineColor}
                                      onChange={(e) => setBurnSettings((prev) => ({ ...prev, outlineColor: e.target.value }))}
                                      className="h-12 w-full rounded-xl border border-gray-200 bg-white"
                                      title="描边颜色"
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-4 text-sm text-gray-500">
                              先从上方时间条或字幕列表里选中一条字幕，再进行单条聚焦编辑。
                            </div>
                          )}

                          <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
                            <div className="text-sm font-semibold text-gray-800">导出动作</div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <button
                                onClick={handleSaveSubtitleFile}
                                disabled={savingSubtitleFile || !subtitleFilePath}
                                className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-sm text-white disabled:opacity-50"
                              >
                                {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                保存字幕
                              </button>
                              <button
                                onClick={handleBurnSubtitleVideo}
                                disabled={!selectedPath || !subtitleFilePath || burningSubtitleVideo}
                                className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm text-white disabled:opacity-50"
                              >
                                {burningSubtitleVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                                生成内嵌字幕视频
                              </button>
                              <button
                                onClick={() => handleDownloadSubtitle('srt')}
                                disabled={subtitleCues.length === 0}
                                className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 disabled:opacity-50"
                              >
                                <Download className="w-4 h-4" />
                                下载 SRT
                              </button>
                              <button
                                onClick={() => handleDownloadVideo(latestBurnedVideoPath || selectedPath)}
                                disabled={!latestBurnedVideoPath && !selectedPath}
                                className="flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 disabled:opacity-50"
                              >
                                <Download className="w-4 h-4" />
                                下载视频
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-4">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800">
                            <Captions className="w-4 h-4 text-emerald-600" />
                            字幕时间条（可点选并直接编辑）
                          </div>
                          <div className="text-xs text-gray-500">
                            当前播放 {formatDuration(currentPlaybackTime)} / {formatDuration(videoDuration)}
                          </div>
                        </div>
                        <div className="relative h-14 overflow-hidden rounded-xl bg-slate-900">
                          {subtitleTimelineCues.length === 0 ? (
                            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                              暂无字幕时间条，先生成或读取 `.srt`
                            </div>
                          ) : (
                            subtitleTimelineCues.map(({ cue, index, start, duration }) => {
                              const left = `${(start / videoDuration) * 100}%`;
                              const width = `${Math.max((duration / videoDuration) * 100, 1)}%`;
                              const isActive = index === activeSubtitleIndex || index === editableTimelineCueIndex;
                              return (
                                <button
                                  key={`${cue.index}-${index}`}
                                  onClick={() => {
                                    setSelectedTimelineCueIndex(index);
                                    handleJumpToCue(cue);
                                  }}
                                  title={`${cue.start} - ${cue.end}\n${cue.text}`}
                                  className={`absolute top-2 h-10 overflow-hidden rounded-md border px-2 text-left ${isActive ? 'border-emerald-200 bg-emerald-400/90 text-slate-900' : 'border-amber-100 bg-amber-300/80 text-slate-900 hover:bg-amber-200'}`}
                                  style={{ left, width, minWidth: '10px' }}
                                >
                                  <span className="block truncate text-[11px] font-medium leading-6">{cue.text}</span>
                                </button>
                              );
                            })
                          )}
                          {videoDuration > 0 && (
                            <div
                              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white/90"
                              style={{ left: `${(currentPlaybackTime / videoDuration) * 100}%` }}
                            />
                          )}
                        </div>
                        {editableTimelineCue && (
                          <div className="mt-3 grid gap-2 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-[180px_180px_minmax(0,1fr)_auto]">
                            <input
                              value={editableTimelineCue.start}
                              onChange={(e) => updateSubtitleCue(editableTimelineCueIndex, 'start', e.target.value)}
                              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                              placeholder="开始时间"
                            />
                            <input
                              value={editableTimelineCue.end}
                              onChange={(e) => updateSubtitleCue(editableTimelineCueIndex, 'end', e.target.value)}
                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                              placeholder="结束时间"
                            />
                            <input
                              value={editableTimelineCue.text}
                              onChange={(e) => updateSubtitleCue(editableTimelineCueIndex, 'text', e.target.value)}
                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                              placeholder="直接编辑这条字幕文本"
                            />
                            <button
                              onClick={handleSaveSubtitleFile}
                              disabled={savingSubtitleFile || !subtitleFilePath}
                              className="flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                            >
                              {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                              保存
                            </button>
                          </div>
                        )}

                        <div className="border-t border-gray-100 pt-4">
                          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <h4 className="text-base font-bold text-gray-800">字幕编辑器</h4>
                              <p className="mt-1 text-sm text-gray-500">编辑结果会直接驱动上方字幕时间条和视频内预览。</p>
                            </div>
                            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                              <button
                                onClick={() => handleDownloadSubtitle('srt')}
                                disabled={subtitleCues.length === 0}
                                className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                              >
                                <Download className="w-4 h-4" />
                                下载 SRT
                              </button>
                              <button
                                onClick={() => handleDownloadSubtitle('json')}
                                disabled={subtitleCues.length === 0}
                                className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 flex items-center gap-2 disabled:opacity-50"
                              >
                                <Download className="w-4 h-4" />
                                下载 JSON
                              </button>
                              <button
                                onClick={handleAddSubtitleCue}
                                className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"
                              >
                                新增字幕
                              </button>
                              <button
                                onClick={handleSaveSubtitleFile}
                                disabled={savingSubtitleFile || !subtitleFilePath}
                                className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                              >
                                {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                保存字幕
                              </button>
                            </div>
                          </div>

                          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
                            <input
                              value={subtitleFilePath}
                              onChange={(e) => setSubtitleFilePath(e.target.value)}
                              placeholder="字幕文件路径，例如 transformed/2026/04/19/xxx_tr.srt"
                              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                            />
                            <button
                              onClick={handleLoadSubtitleEditor}
                              disabled={!selectedPath || loadingSubtitleFile}
                              className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                            >
                              {loadingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                              读取字幕
                            </button>
                          </div>

                          <div className="mb-3 text-xs text-gray-500">
                            默认会按当前视频推断同名 `.srt` 路径。时间格式使用 `00:00:12,345`，编辑后点“保存字幕”即可落盘。
                          </div>

                          <div className="max-h-[520px] space-y-3 overflow-auto">
                            {subtitleCues.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-gray-200 p-4 text-sm text-gray-500">
                                还没有载入字幕。先生成 `.srt`，或者直接输入字幕路径后点击“读取字幕”。
                              </div>
                            ) : (
                              subtitleCues.map((cue, index) => (
                                <div
                                  key={`${cue.index}-${index}`}
                                  className={`rounded-xl border p-4 ${activeSubtitleIndex === index ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50/60'}`}
                                >
                                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        onClick={() => handleJumpToCue(cue)}
                                        className="text-sm font-semibold text-gray-800 hover:text-emerald-600"
                                      >
                                        第 {index + 1} 条
                                      </button>
                                      {activeSubtitleIndex === index && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => handleJumpToCue(cue)}
                                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600"
                                      >
                                        跳转
                                      </button>
                                      <button
                                        onClick={() => removeSubtitleCue(index)}
                                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-600"
                                      >
                                        删除
                                      </button>
                                    </div>
                                  </div>
                                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <input
                                      value={cue.start}
                                      onChange={(e) => updateSubtitleCue(index, 'start', e.target.value)}
                                      placeholder="开始时间"
                                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                                    />
                                    <input
                                      value={cue.end}
                                      onChange={(e) => updateSubtitleCue(index, 'end', e.target.value)}
                                      placeholder="结束时间"
                                      className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                                    />
                                  </div>
                                  <textarea
                                    value={cue.text}
                                    onChange={(e) => updateSubtitleCue(index, 'text', e.target.value)}
                                    rows={3}
                                    placeholder="字幕文本"
                                    className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                                  />
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="rounded-2xl border border-sky-100 bg-sky-50/70 p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <HardDrive className="w-4 h-4 text-sky-600" />
                        文件管理摘要
                      </div>
                      <div className="mt-3 space-y-2 text-sm text-slate-600">
                        <div>当前播放 {formatDuration(currentPlaybackTime)} / {formatDuration(videoDuration)}</div>
                        <div>本地目标目录: {copyTargetDir || '未指定'}</div>
                        <div>远程目录: {selectedRemoteDir || '/'}</div>
                        <div>当前模式只保留预览和文件流转，不显示字幕时间轴。</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                    <button
                      onClick={() => setShowVideoInfoDetails((prev) => !prev)}
                      className="w-full flex items-center justify-between text-left"
                    >
                      <div className="text-sm font-semibold text-gray-800">基础信息</div>
                      {showVideoInfoDetails ? (
                        <ChevronUp className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {!showVideoInfoDetails && (
                      <div className="mt-2 text-xs text-gray-500">
                        {selectedFile?.name || '未选择文件'} · {formatDuration(videoInfo?.duration || 0)} · {selectedFile ? formatSize(selectedFile.size) : '-'}
                      </div>
                    )}
                    {showVideoInfoDetails && (
                      <div className="mt-3 space-y-2 text-sm text-gray-600">
                        <div><span className="text-gray-400">文件:</span> {selectedFile?.name}</div>
                        <div><span className="text-gray-400">相对路径:</span> <span className="break-all">{selectedPath}</span></div>
                        <div><span className="text-gray-400">大小:</span> {selectedFile ? formatSize(selectedFile.size) : '-'}</div>
                        <div><span className="text-gray-400">修改时间:</span> {selectedFile ? formatDate(selectedFile.mtime) : '-'}</div>
                        <div><span className="text-gray-400">时长:</span> {formatDuration(videoInfo?.duration || 0)}</div>
                        <div><span className="text-gray-400">分辨率:</span> {videoInfo?.width && videoInfo?.height ? `${videoInfo.width} x ${videoInfo.height}` : '未知'}</div>
                        <div><span className="text-gray-400">编码:</span> {videoInfo?.codec || '未知'}</div>
                        <div><span className="text-gray-400">码率:</span> {videoInfo?.bit_rate ? `${Math.round(videoInfo.bit_rate / 1000)} kbps` : '未知'}</div>
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => handleDownloadVideo(selectedPath)}
                        disabled={!selectedPath}
                        className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
                      >
                        <Download className="w-4 h-4" />
                        下载当前视频
                      </button>
                      {latestBurnedVideoPath && (
                        <button
                          onClick={() => handleDownloadVideo(latestBurnedVideoPath)}
                          className="px-3 py-2 rounded-lg border border-emerald-200 text-sm text-emerald-700 bg-emerald-50 hover:bg-emerald-100 flex items-center gap-2"
                        >
                          <Download className="w-4 h-4" />
                          下载内嵌字幕视频
                        </button>
                      )}
                    </div>
                  </div>

                  {isFileManagerMode ? (
                    <div className="rounded-xl border border-gray-100 p-4">
                      <div className="mb-3 text-sm font-semibold text-gray-800">本地复制</div>
                      <div className="mb-2 flex flex-col gap-2 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
                        <span>当前目录: {localBrowsePath}</span>
                        <button
                          onClick={() => {
                            const parent = localBrowsePath === '/' ? '/' : localBrowsePath.split('/').slice(0, -1).join('/') || '/';
                            loadLocalEntries(parent);
                          }}
                          className="rounded border border-gray-200 px-2 py-1 hover:bg-gray-50"
                        >
                          返回上级
                        </button>
                      </div>
                      <div className="max-h-48 overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100 bg-gray-50/50">
                        {loadingLocalEntries ? (
                          <div className="flex items-center gap-2 p-3 text-sm text-gray-500">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            读取中...
                          </div>
                        ) : (
                          localEntries.map((entry) => (
                            <div
                              key={entry.path}
                              className={`flex items-center justify-between p-2.5 hover:bg-white ${selectedLocalEntryPath === entry.path ? 'bg-blue-50' : ''}`}
                            >
                              <button
                                onClick={() => {
                                  setSelectedLocalEntryPath(entry.path);
                                  setSelectedLocalEntryName(entry.name);
                                  setSelectedLocalEntryIsDir(entry.is_dir);
                                  setRenameLocalName(entry.name);
                                  if (entry.is_dir) {
                                    setSelectedLocalDir(entry.path);
                                    setCopyTargetDir(entry.path);
                                  }
                                }}
                                onDoubleClick={() => {
                                  if (entry.is_dir) {
                                    loadLocalEntries(entry.path);
                                  }
                                }}
                                className="min-w-0 text-left flex items-center gap-2"
                              >
                                {entry.is_dir ? <FolderOpen className="h-4 w-4 text-amber-600" /> : <File className="h-4 w-4 text-slate-400" />}
                                <span className="truncate text-sm text-gray-700">{entry.name}</span>
                                {entry.is_dir && <ChevronRight className="h-4 w-4 text-gray-400" />}
                              </button>
                              {entry.is_dir && (
                                <button
                                  onClick={() => {
                                    setSelectedLocalDir(entry.path);
                                    setCopyTargetDir(entry.path);
                                  }}
                                  className={`rounded border px-2 py-1 text-xs ${selectedLocalDir === entry.path ? 'border-slate-900 bg-slate-900 text-white' : 'border-gray-200 hover:bg-gray-50'}`}
                                >
                                  选为目标
                                </button>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                      <div className="mt-2 text-xs text-gray-500">
                        复制目标会自动补成 `当前目录/YYYY/MM/DD/文件名`。
                      </div>
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                        <input
                          value={copyTargetDir}
                          onChange={(e) => setCopyTargetDir(e.target.value)}
                          placeholder="当前选择的本地目标目录"
                          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                        />
                        <button
                          onClick={handleCopyToLocal}
                          disabled={copyingLocal}
                          className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                        >
                          {copyingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                          复制
                        </button>
                      </div>
                      <div className="mt-3 space-y-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                        <div className="text-sm font-semibold text-gray-800">本地目录操作</div>
                        <div className="text-xs text-gray-500">当前选中: {selectedLocalEntryPath || '未选择'}</div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            value={newLocalFolderName}
                            onChange={(e) => setNewLocalFolderName(e.target.value)}
                            placeholder="新建文件夹名称"
                            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                          />
                          <button
                            onClick={handleCreateLocalFolder}
                            disabled={creatingLocalFolder}
                            className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                          >
                            {creatingLocalFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                            新建
                          </button>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            value={renameLocalName}
                            onChange={(e) => setRenameLocalName(e.target.value)}
                            placeholder="重命名当前选中项"
                            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                          />
                          <button
                            onClick={handleRenameLocal}
                            disabled={renamingLocal || !selectedLocalEntryPath}
                            className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                          >
                            {renamingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
                            重命名
                          </button>
                          <button
                            onClick={handleDeleteLocal}
                            disabled={deletingLocal || !selectedLocalEntryPath}
                            className="flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
                          >
                            {deletingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
                      <div className="mb-3 text-sm font-semibold text-gray-800">字幕状态</div>
                      <div className="space-y-2 text-sm text-gray-600">
                        <div>字幕文件: {subtitleFilePath || '未指定'}</div>
                        <div>已载入字幕: {subtitleCues.length > 0 ? `${subtitleCues.length} 条` : '0 条'}</div>
                        <div>Whisper 地址: {subtitleSettings.subtitleLocalWhisperUrl || '未配置'}</div>
                        <div>模型: {subtitleSettings.subtitleLocalModel || '未配置'}</div>
                        <div>上传联动: {subtitleSettings.subtitleAutoGenerateOnUpload ? '自动生成字幕' : '关闭'}</div>
                        <div>烧录联动: {subtitleSettings.subtitleAutoBurnAfterGenerate ? '自动烧录' : '关闭'}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">请先在左侧选择一个视频文件。</div>
            )}
          </div>

          <div className={`grid gap-6 ${isFileManagerMode ? 'xl:grid-cols-[1.15fr_0.85fr]' : 'xl:grid-cols-[0.95fr_1.05fr]'}`}>
            {isSubtitleWorkshopMode && (
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <h3 className="mb-3 text-lg font-bold text-gray-800">字幕生成</h3>
                <p className="mb-3 text-sm text-gray-500">配置本地 Whisper，直接为当前视频产出 `.srt`、`.json` 和后续烧录所需素材。</p>
                <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <select
                    value={selectedFfmpegPreset}
                    onChange={(e) => {
                      const selectedValue = e.target.value;
                      setSelectedFfmpegPreset(selectedValue);
                      if (selectedValue) {
                        setFfmpegArgs(selectedValue);
                      }
                    }}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none sm:min-w-[320px] sm:w-auto"
                  >
                    <option value="">自定义命令（未保存）</option>
                    {ffmpegPresets.map((preset) => (
                      <option key={preset} value={preset}>
                        {preset}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleSaveCurrentFfmpegPreset}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  >
                    <Save className="h-4 w-4" />
                    保存为预设
                  </button>
                  <button
                    onClick={() => setFfmpegArgs(defaultArgs)}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  >
                    恢复默认
                  </button>
                </div>
                <textarea
                  value={ffmpegArgs}
                  onChange={(e) => setFfmpegArgs(e.target.value)}
                  rows={5}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm focus:outline-none"
                />
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    onClick={handleTransform}
                    disabled={!selectedPath || transforming}
                    className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {transforming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    {generateSubtitles ? '开始转码并生成字幕' : '开始转码'}
                  </button>
                  <button
                    onClick={handleGenerateSubtitlesOnly}
                    disabled={!selectedPath || generatingSubtitlesOnly}
                    className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 disabled:opacity-50"
                  >
                    {generatingSubtitlesOnly ? <Loader2 className="h-4 w-4 animate-spin" /> : <File className="h-4 w-4" />}
                    单独生成字幕
                  </button>
                </div>

                <div className="mt-4 space-y-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-800">AI 字幕</div>
                      <div className="mt-1 text-xs text-gray-500">字幕工坊模式下，这里专门负责模型配置和字幕生成，不和文件搬运区混排。</div>
                    </div>
                    <label className="whitespace-nowrap flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={generateSubtitles}
                        onChange={(e) => setGenerateSubtitles(e.target.checked)}
                      />
                      生成字幕
                    </label>
                  </div>

                  <input
                    value={subtitleSettings.subtitleLocalWhisperUrl}
                    onChange={(e) =>
                      setSubtitleSettings((prev) => ({ ...prev, subtitleLocalWhisperUrl: e.target.value }))
                    }
                    placeholder="本地 Whisper 地址，例如 http://127.0.0.1:9001"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                  />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <input
                      value={subtitleSettings.subtitleLocalModel}
                      onChange={(e) =>
                        setSubtitleSettings((prev) => ({ ...prev, subtitleLocalModel: e.target.value }))
                      }
                      placeholder="本地 Whisper 模型，例如 medium"
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                    />
                    <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={subtitleSettings.subtitleWordTimestamps}
                        onChange={(e) =>
                          setSubtitleSettings((prev) => ({ ...prev, subtitleWordTimestamps: e.target.checked }))
                        }
                      />
                      开启逐词时间戳
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={subtitleSettings.subtitleAutoGenerateOnUpload}
                        onChange={(e) =>
                          setSubtitleSettings((prev) => ({ ...prev, subtitleAutoGenerateOnUpload: e.target.checked }))
                        }
                      />
                      上传后自动生成字幕
                    </label>
                    <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={subtitleSettings.subtitleAutoBurnAfterGenerate}
                        onChange={(e) =>
                          setSubtitleSettings((prev) => ({ ...prev, subtitleAutoBurnAfterGenerate: e.target.checked }))
                        }
                      />
                      自动烧录内嵌字幕
                    </label>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <select
                      value={subtitleSettings.subtitleMode}
                      onChange={(e) =>
                        setSubtitleSettings((prev) => ({ ...prev, subtitleMode: e.target.value }))
                      }
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                    >
                      {subtitleModeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={subtitleSettings.subtitleLanguage}
                      onChange={(e) =>
                        setSubtitleSettings((prev) => ({ ...prev, subtitleLanguage: e.target.value }))
                      }
                      placeholder={subtitleSettings.subtitleMode === 'mixed' ? '混合原声模式下留空' : '语言代码，可留空，如 zh'}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                    />
                    <button
                      onClick={saveSubtitleSettings}
                      disabled={savingSubtitleSettings}
                      className="flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                    >
                      {savingSubtitleSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      保存字幕配置
                    </button>
                  </div>
                  <div className="text-xs text-gray-500">
                    说明：双语模式为“原文 + 英文”。若英文音频要生成中文译文，需接入额外翻译模型。
                  </div>
                  <textarea
                    value={subtitleSettings.subtitlePrompt}
                    onChange={(e) =>
                      setSubtitleSettings((prev) => ({ ...prev, subtitlePrompt: e.target.value }))
                    }
                    rows={3}
                    placeholder="可选提示词（默认留空），例如：保留口语停顿。"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                  />
                  <button
                    onClick={handleTestSubtitleApi}
                    disabled={testingSubtitleApi}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {testingSubtitleApi ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube2 className="h-4 w-4" />}
                    测试本地 Whisper
                  </button>
                </div>
              </section>
            )}

            {isFileManagerMode && (
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <h3 className="mb-3 text-lg font-bold text-gray-800">文件流转</h3>
                <p className="mb-4 text-sm text-gray-500">文件管理模式把复制、上传和目录整理放在同一块，减少在字幕控件之间来回跳。</p>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                    <div className="mb-2 text-sm font-semibold text-slate-800">本地复制</div>
                    <div className="mb-2 text-xs text-slate-500">复制目标会自动补成 `当前目录/YYYY/MM/DD/文件名`。</div>
                    <input
                      value={copyTargetDir}
                      onChange={(e) => setCopyTargetDir(e.target.value)}
                      placeholder="当前选择的本地目标目录"
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                    />
                    <button
                      onClick={handleCopyToLocal}
                      disabled={copyingLocal}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                    >
                      {copyingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                      复制到本地
                    </button>
                  </div>
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                    <div className="mb-2 text-sm font-semibold text-slate-800">WebDAV 上传</div>
                    <div className="mb-2 text-xs text-slate-500">上传会自动补成 `远程目录/YYYY/MM/DD/文件名`。</div>
                    <div className="rounded-lg border border-white/70 bg-white/70 px-3 py-2 text-sm text-slate-700">
                      当前远程目录: {selectedRemoteDir || '/'}
                    </div>
                    <button
                      onClick={handleUploadToWebDAV}
                      disabled={!selectedPath || uploadingWebDAV}
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {uploadingWebDAV ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      上传当前文件到 WebDAV
                    </button>
                  </div>
                </div>
              </section>
            )}

            {isFileManagerMode && (
              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                <button
                  onClick={() => setShowWebdavDetails((prev) => !prev)}
                  className="flex w-full items-center justify-between"
                >
                  <div className="text-left">
                    <h3 className="text-lg font-bold text-gray-800">WebDAV 文件管理</h3>
                    <p className="mt-1 text-sm text-gray-500">点击展开连接、目录预览、测试连接和上传细节。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-slate-500" />
                    {showWebdavDetails ? (
                      <ChevronUp className="h-4 w-4 text-gray-500" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-500" />
                    )}
                  </div>
                </button>
                {!showWebdavDetails && (
                  <div className="mt-3 text-xs text-gray-500">
                    当前远程目录：{selectedRemoteDir || '/'} · 地址：{webdavSettings.webdavUrl || '未配置'}
                  </div>
                )}

                {showWebdavDetails && (
                  <div className="mt-4 space-y-3">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={webdavSettings.webdavEnabled}
                        onChange={(e) =>
                          setWebdavSettings((prev) => ({ ...prev, webdavEnabled: e.target.checked }))
                        }
                      />
                      启用 WebDAV
                    </label>

                    <input
                      value={webdavSettings.webdavUrl}
                      onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavUrl: e.target.value }))}
                      placeholder="WebDAV 地址"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                    />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <input
                        value={webdavSettings.webdavUsername}
                        onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavUsername: e.target.value }))}
                        placeholder="用户名"
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                      />
                      <input
                        type="password"
                        value={webdavSettings.webdavPassword}
                        onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavPassword: e.target.value }))}
                        placeholder="密码"
                        className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                      />
                    </div>
                    <input
                      value={webdavSettings.webdavBasePath}
                      onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavBasePath: e.target.value }))}
                      placeholder="远程基础目录"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none"
                    />

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={saveWebDAVSettings}
                        disabled={savingWebDAV}
                        className="flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                      >
                        {savingWebDAV ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        保存配置
                      </button>
                      <button
                        onClick={testWebDAV}
                        disabled={testingWebDAV}
                        className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                      >
                        {testingWebDAV ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube2 className="h-4 w-4" />}
                        测试连接
                      </button>
                      <button
                        onClick={() => listWebDAVDirectories(selectedRemoteDir)}
                        disabled={listingWebDAV}
                        className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                      >
                        {listingWebDAV ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                        读取目录
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={webdavSettings.webdavUploadDownloads}
                          onChange={(e) =>
                            setWebdavSettings((prev) => ({ ...prev, webdavUploadDownloads: e.target.checked }))
                          }
                        />
                        下载后自动上传
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={webdavSettings.webdavUploadTransformed}
                          onChange={(e) =>
                            setWebdavSettings((prev) => ({ ...prev, webdavUploadTransformed: e.target.checked }))
                          }
                        />
                        转码后自动上传
                      </label>
                    </div>

                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 text-sm font-semibold text-gray-800">远程目录选择</div>
                      <div className="mb-2 flex flex-col gap-2 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
                        <span>当前远程目录: {selectedRemoteDir || '/'}</span>
                        <button
                          onClick={() => {
                            const parent = selectedRemoteDir.split('/').slice(0, -1).join('/');
                            listWebDAVDirectories(parent);
                          }}
                          className="rounded border border-gray-200 px-2 py-1 hover:bg-white"
                        >
                          返回上级
                        </button>
                      </div>
                      <div className="mb-2 text-xs text-gray-500">
                        手动上传会自动补成 `当前远程目录/YYYY/MM/DD/文件名`。
                      </div>
                      <div className="max-h-56 overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100 bg-white">
                        <div className="flex items-center justify-between bg-slate-50 p-2.5">
                          <button
                            onClick={() => setSelectedRemoteDir('')}
                            className={`text-sm ${selectedRemoteDir === '' ? 'font-semibold text-slate-900' : 'text-gray-600'}`}
                          >
                            /
                          </button>
                        </div>
                        {webdavDirectories.map((entry) => (
                          <div
                            key={`${entry.path}-${entry.name}`}
                            className={`flex items-center justify-between p-2.5 hover:bg-slate-50 ${selectedRemoteEntryPath === entry.path ? 'bg-emerald-50' : ''}`}
                          >
                            <button
                              onClick={() => {
                                setSelectedRemoteEntryPath(entry.path);
                                setSelectedRemoteEntryName(entry.name);
                                setSelectedRemoteEntryIsDir(entry.is_dir);
                                setRenameRemoteName(entry.name);
                                if (entry.is_dir) {
                                  setSelectedRemoteDir(entry.path);
                                }
                              }}
                              onDoubleClick={() => {
                                if (entry.is_dir) {
                                  listWebDAVDirectories(entry.path);
                                }
                              }}
                              className="min-w-0 text-left flex items-center gap-2"
                            >
                              {entry.is_dir ? <FolderOpen className="h-4 w-4 text-blue-600" /> : <File className="h-4 w-4 text-slate-400" />}
                              <span className="truncate text-sm text-gray-700">{entry.name}</span>
                              {entry.is_dir && <ChevronRight className="h-4 w-4 text-gray-400" />}
                            </button>
                            <button
                              onClick={() => setSelectedRemoteDir(entry.is_dir ? entry.path : selectedRemoteDir)}
                              disabled={!entry.is_dir}
                              className={`rounded border px-2 py-1 text-xs ${entry.is_dir && selectedRemoteDir === entry.path ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-gray-200'} ${!entry.is_dir ? 'cursor-not-allowed opacity-40' : 'hover:bg-emerald-50'}`}
                            >
                              选中
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 text-xs text-gray-500">
                        现在会显示远程目录和文件。目录可以进入并选中，文件只展示不选中。
                      </div>
                      <div className="mt-3 space-y-2 rounded-xl border border-gray-100 bg-white p-3">
                        <div className="text-sm font-semibold text-gray-800">远程目录操作</div>
                        <div className="text-xs text-gray-500">当前选中: {selectedRemoteEntryPath || '未选择'}</div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            value={newRemoteFolderName}
                            onChange={(e) => setNewRemoteFolderName(e.target.value)}
                            placeholder="新建远程文件夹名称"
                            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                          />
                          <button
                            onClick={handleCreateRemoteFolder}
                            disabled={creatingRemoteFolder}
                            className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                          >
                            {creatingRemoteFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
                            新建
                          </button>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            value={renameRemoteName}
                            onChange={(e) => setRenameRemoteName(e.target.value)}
                            placeholder="重命名远程选中项"
                            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none"
                          />
                          <button
                            onClick={handleRenameRemote}
                            disabled={renamingRemote || !selectedRemoteEntryPath}
                            className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                          >
                            {renamingRemote ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
                            重命名
                          </button>
                          <button
                            onClick={handleDeleteRemote}
                            disabled={deletingRemote || !selectedRemoteEntryPath}
                            className="flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
                          >
                            {deletingRemote ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

        </section>
      </div>
    </main>
  );
};
