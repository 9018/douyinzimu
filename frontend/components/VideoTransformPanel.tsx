import {
  Captions,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  File,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  PencilLine,
  RefreshCw,
  Save,
  Server,
  TestTube2,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../services/bridge';
import type { SubtitleCue } from '../services/api';
import { logger } from '../services/logger';
import { AppSettings } from '../types';
import { toast } from './Toast';

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
  '-filter_complex "rotate=1*PI/180,eq=brightness=0.02:saturation=1.05,scale=1080:-2" -c:v libx264 -crf 23 -preset fast -c:a aac';

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
  subtitlePrompt: '',
  subtitleLocalWhisperUrl: 'http://host.docker.internal:9001',
  subtitleLocalModel: 'medium',
  subtitleWordTimestamps: true,
};

const defaultBurnSettings = {
  fontName: 'Noto Sans CJK SC',
  fontSize: 18,
  marginV: 24,
  outline: 2,
  shadow: 0,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  alignment: 2,
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
  const [timePart, milliseconds = '0'] = timestamp.split(',');
  const [hours = '0', minutes = '0', seconds = '0'] = timePart.split(':');
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
};

const buildSrtFromCues = (cues: SubtitleCue[]) => {
  return cues
    .map((cue, index) => `${index + 1}\n${cue.start} --> ${cue.end}\n${cue.text.trim()}\n`)
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

export const VideoTransformPanel: React.FC = () => {
  const [files, setFiles] = useState<VideoFileItem[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [ffmpegArgs, setFfmpegArgs] = useState(defaultArgs);
  const [loading, setLoading] = useState(false);
  const [transforming, setTransforming] = useState(false);
  const [generatingSubtitlesOnly, setGeneratingSubtitlesOnly] = useState(false);
  const [copyTargetDir, setCopyTargetDir] = useState('');
  const [localBrowsePath, setLocalBrowsePath] = useState('/root');
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
  const [testingSubtitleApi, setTestingSubtitleApi] = useState(false);
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const selectedFile = useMemo(
    () => files.find((f) => f.path === selectedPath),
    [files, selectedPath]
  );
  const previewUrl = selectedPath ? bridge.getMediaUrl(selectedPath) : '';
  const videoDuration = videoInfo?.duration || 0;
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
        setSubtitleCues(result.cues);
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
        subtitleLanguage: settings.subtitleLanguage,
        subtitlePrompt: settings.subtitlePrompt,
        subtitleLocalWhisperUrl: settings.subtitleLocalWhisperUrl,
        subtitleLocalModel: settings.subtitleLocalModel,
        subtitleWordTimestamps: settings.subtitleWordTimestamps,
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
        subtitle_language: subtitleSettings.subtitleLanguage.trim() || undefined,
        subtitle_prompt: subtitleSettings.subtitlePrompt.trim() || undefined,
      });
      if (result.success && result.output_path) {
        const extras = [
          result.subtitle_path ? `字幕：${result.subtitle_path}` : '',
          result.subtitle_wav_path ? `音轨：${result.subtitle_wav_path}` : '',
        ].filter(Boolean).join('，');
        const extraMessage = extras ? `，${extras}` : '';
        toast.success(`转码完成：${result.output_path}${extraMessage}`);
        logger.success(`转码完成: ${result.output_path}${extraMessage}`, undefined, 'transform');
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
        subtitle_prompt: subtitleSettings.subtitlePrompt.trim() || undefined,
      });
      if (result.success && result.subtitle_path) {
        const wavMessage = result.subtitle_wav_path ? `，音轨：${result.subtitle_wav_path}` : '';
        toast.success(`字幕生成完成：${result.subtitle_path}${wavMessage}`);
        logger.success(`字幕生成完成: ${result.subtitle_path}`, undefined, 'transform');
        setSubtitleFilePath(result.subtitle_path);
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
        setSubtitleCues(result.cues);
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
      });
      if (result.success && result.output_path) {
        toast.success(`内嵌字幕视频已生成：${result.output_path}`);
        logger.success(`内嵌字幕视频已生成: ${result.output_path}`, undefined, 'transform');
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
        toast.success(`已上传到 WebDAV: ${result.remote_path}`);
        logger.success(`文件已上传到 WebDAV: ${result.remote_path}`, undefined, 'webdav');
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
    loadLocalEntries('/root');
  }, []);

  useEffect(() => {
    if (selectedPath) {
      loadVideoInfo(selectedPath);
      setSubtitleFilePath(buildSubtitlePath(selectedPath));
      setSubtitleCues([]);
      setCurrentPlaybackTime(0);
    } else {
      setVideoInfo(null);
      setSubtitleFilePath('');
      setSubtitleCues([]);
      setCurrentPlaybackTime(0);
    }
  }, [selectedPath]);

  return (
    <main className="flex-1 min-w-0 p-8 overflow-y-auto bg-[#F8F9FB]">
      <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-6">
        <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-gray-800">文件管理</h2>
              <p className="text-sm text-gray-500 mt-1">预览、转码、复制和上传已下载视频。</p>
            </div>
            <button
              onClick={() => loadFiles(false)}
              disabled={loading}
              className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              刷新
            </button>
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100">
            {files.length === 0 ? (
              <div className="text-sm text-gray-500 p-4">暂无视频文件，请先下载。</div>
            ) : (
              files.map((file) => (
                <label key={file.path} className="flex items-center justify-between p-3 hover:bg-gray-50 cursor-pointer">
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
              <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5">
                <div className="rounded-2xl overflow-hidden bg-black min-h-[360px] flex items-center justify-center">
                  <video
                    key={previewUrl}
                    ref={videoRef}
                    src={previewUrl}
                    controls
                    onTimeUpdate={(e) => setCurrentPlaybackTime(e.currentTarget.currentTime)}
                    className="w-full h-full max-h-[520px] object-contain"
                  />
                </div>
                <div className="mt-3 rounded-2xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                      <Captions className="w-4 h-4 text-emerald-600" />
                      字幕时间条
                    </div>
                    <div className="text-xs text-gray-500">
                      当前播放 {formatDuration(currentPlaybackTime)} / {formatDuration(videoDuration)}
                    </div>
                  </div>
                  <div className="relative h-14 rounded-xl bg-slate-900 overflow-hidden">
                    {subtitleTimelineCues.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-400">
                        暂无字幕时间条，先生成或读取 `.srt`
                      </div>
                    ) : (
                      subtitleTimelineCues.map(({ cue, index, start, duration }) => {
                        const left = `${(start / videoDuration) * 100}%`;
                        const width = `${Math.max((duration / videoDuration) * 100, 1)}%`;
                        const isActive = index === activeSubtitleIndex;
                        return (
                          <button
                            key={`${cue.index}-${index}`}
                            onClick={() => handleJumpToCue(cue)}
                            title={`${cue.start} - ${cue.end}\n${cue.text}`}
                            className={`absolute top-2 h-10 rounded-md border text-left px-2 overflow-hidden ${isActive ? 'bg-emerald-400/90 border-emerald-200 text-slate-900' : 'bg-amber-300/80 border-amber-100 text-slate-900 hover:bg-amber-200'}`}
                            style={{ left, width, minWidth: '10px' }}
                          >
                            <span className="block truncate text-[11px] font-medium leading-6">{cue.text}</span>
                          </button>
                        );
                      })
                    )}
                    {videoDuration > 0 && (
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-white/90 pointer-events-none"
                        style={{ left: `${(currentPlaybackTime / videoDuration) * 100}%` }}
                      />
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                    <div className="text-sm font-semibold text-gray-800 mb-3">基础信息</div>
                    <div className="space-y-2 text-sm text-gray-600">
                      <div><span className="text-gray-400">文件:</span> {selectedFile?.name}</div>
                      <div><span className="text-gray-400">相对路径:</span> <span className="break-all">{selectedPath}</span></div>
                      <div><span className="text-gray-400">大小:</span> {selectedFile ? formatSize(selectedFile.size) : '-'}</div>
                      <div><span className="text-gray-400">修改时间:</span> {selectedFile ? formatDate(selectedFile.mtime) : '-'}</div>
                      <div><span className="text-gray-400">时长:</span> {formatDuration(videoInfo?.duration || 0)}</div>
                      <div><span className="text-gray-400">分辨率:</span> {videoInfo?.width && videoInfo?.height ? `${videoInfo.width} x ${videoInfo.height}` : '未知'}</div>
                      <div><span className="text-gray-400">编码:</span> {videoInfo?.codec || '未知'}</div>
                      <div><span className="text-gray-400">码率:</span> {videoInfo?.bit_rate ? `${Math.round(videoInfo.bit_rate / 1000)} kbps` : '未知'}</div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-100 p-4">
                    <div className="text-sm font-semibold text-gray-800 mb-3">本地复制</div>
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                      <span>当前目录: {localBrowsePath}</span>
                      <button
                        onClick={() => {
                          const parent = localBrowsePath === '/' ? '/' : localBrowsePath.split('/').slice(0, -1).join('/') || '/';
                          loadLocalEntries(parent);
                        }}
                        className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                      >
                        返回上级
                      </button>
                    </div>
                    <div className="max-h-48 overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100 bg-gray-50/50">
                      {loadingLocalEntries ? (
                        <div className="p-3 text-sm text-gray-500 flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
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
                              className="flex items-center gap-2 min-w-0 text-left"
                            >
                              {entry.is_dir ? <FolderOpen className="w-4 h-4 text-amber-600" /> : <File className="w-4 h-4 text-slate-400" />}
                              <span className="text-sm text-gray-700 truncate">{entry.name}</span>
                              {entry.is_dir && <ChevronRight className="w-4 h-4 text-gray-400" />}
                            </button>
                            {entry.is_dir && (
                              <button
                                onClick={() => {
                                  setSelectedLocalDir(entry.path);
                                  setCopyTargetDir(entry.path);
                                }}
                                className={`px-2 py-1 text-xs rounded border ${selectedLocalDir === entry.path ? 'bg-slate-900 text-white border-slate-900' : 'border-gray-200 hover:bg-gray-50'}`}
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
                    <div className="mt-2 flex gap-2">
                      <input
                        value={copyTargetDir}
                        onChange={(e) => setCopyTargetDir(e.target.value)}
                        placeholder="当前选择的本地目标目录"
                        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none bg-white"
                      />
                      <button
                        onClick={handleCopyToLocal}
                        disabled={copyingLocal}
                        className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                      >
                        {copyingLocal ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                        复制
                      </button>
                    </div>
                    <div className="mt-3 rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2">
                      <div className="text-sm font-semibold text-gray-800">本地目录操作</div>
                      <div className="text-xs text-gray-500">当前选中: {selectedLocalEntryPath || '未选择'}</div>
                      <div className="flex gap-2">
                        <input
                          value={newLocalFolderName}
                          onChange={(e) => setNewLocalFolderName(e.target.value)}
                          placeholder="新建文件夹名称"
                          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        />
                        <button
                          onClick={handleCreateLocalFolder}
                          disabled={creatingLocalFolder}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {creatingLocalFolder ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
                          新建
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={renameLocalName}
                          onChange={(e) => setRenameLocalName(e.target.value)}
                          placeholder="重命名当前选中项"
                          className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                        />
                        <button
                          onClick={handleRenameLocal}
                          disabled={renamingLocal || !selectedLocalEntryPath}
                          className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {renamingLocal ? <Loader2 className="w-4 h-4 animate-spin" /> : <PencilLine className="w-4 h-4" />}
                          重命名
                        </button>
                        <button
                          onClick={handleDeleteLocal}
                          disabled={deletingLocal || !selectedLocalEntryPath}
                          className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {deletingLocal ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">请先在左侧选择一个视频文件。</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-6">
            <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-lg font-bold text-gray-800 mb-3">视频转码</h3>
              <p className="text-sm text-gray-500 mb-3">输出目录固定为 <code>transformed/YYYY/MM/DD</code>，文件名自动加 <code>_tr</code>。</p>
              <textarea
                value={ffmpegArgs}
                onChange={(e) => setFfmpegArgs(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl bg-gray-50 focus:outline-none text-sm font-mono"
              />
              <button
                onClick={handleTransform}
                disabled={!selectedPath || transforming}
                className="mt-4 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {transforming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                {generateSubtitles ? '开始转码并生成字幕' : '开始转码'}
              </button>
              <button
                onClick={handleGenerateSubtitlesOnly}
                disabled={!selectedPath || generatingSubtitlesOnly}
                className="mt-3 px-4 py-2.5 rounded-xl border border-blue-200 text-blue-700 bg-blue-50 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {generatingSubtitlesOnly ? <Loader2 className="w-4 h-4 animate-spin" /> : <File className="w-4 h-4" />}
                单独生成字幕
              </button>

              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-gray-800">AI 字幕</div>
                    <div className="text-xs text-gray-500 mt-1">使用本地 Whisper 服务，为当前视频输出 `.srt`、`.json` 和 `.wav`。</div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={generateSubtitles}
                      onChange={(e) => setGenerateSubtitles(e.target.checked)}
                    />
                    生成字幕
                  </label>
                </div>
                <div className="text-xs text-gray-500">
                  单独生成字幕会直接为当前选中视频输出同名 `.srt` 和 `.json`，不会额外生成 `_tr` 视频。
                </div>

                <input
                  value={subtitleSettings.subtitleLocalWhisperUrl}
                  onChange={(e) =>
                    setSubtitleSettings((prev) => ({ ...prev, subtitleLocalWhisperUrl: e.target.value }))
                  }
                  placeholder="本地 Whisper 地址，例如 http://127.0.0.1:9001"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={subtitleSettings.subtitleLocalModel}
                    onChange={(e) =>
                      setSubtitleSettings((prev) => ({ ...prev, subtitleLocalModel: e.target.value }))
                    }
                    placeholder="本地 Whisper 模型，例如 medium"
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                  />
                  <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 bg-white">
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
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={subtitleSettings.subtitleLanguage}
                    onChange={(e) =>
                      setSubtitleSettings((prev) => ({ ...prev, subtitleLanguage: e.target.value }))
                    }
                    placeholder="语言代码，可留空，如 zh"
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                  />
                  <button
                    onClick={saveSubtitleSettings}
                    disabled={savingSubtitleSettings}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {savingSubtitleSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    保存字幕配置
                  </button>
                </div>
                <textarea
                  value={subtitleSettings.subtitlePrompt}
                  onChange={(e) =>
                    setSubtitleSettings((prev) => ({ ...prev, subtitlePrompt: e.target.value }))
                  }
                  rows={3}
                  placeholder="可选提示词，例如：保留口语停顿，输出简体中文字幕。"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                />
                <button
                  onClick={handleTestSubtitleApi}
                  disabled={testingSubtitleApi}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {testingSubtitleApi ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
                  测试本地 Whisper
                </button>
              </div>
            </section>

            <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-lg font-bold text-gray-800">WebDAV 文件管理</h3>
                  <p className="text-sm text-gray-500 mt-1">专门放 WebDAV 连接、目录预览、测试连接和上传。</p>
                </div>
                <Server className="w-5 h-5 text-slate-500" />
              </div>

              <div className="space-y-3">
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
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    value={webdavSettings.webdavUsername}
                    onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavUsername: e.target.value }))}
                    placeholder="用户名"
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                  />
                  <input
                    type="password"
                    value={webdavSettings.webdavPassword}
                    onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavPassword: e.target.value }))}
                    placeholder="密码"
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                  />
                </div>
                <input
                  value={webdavSettings.webdavBasePath}
                  onChange={(e) => setWebdavSettings((prev) => ({ ...prev, webdavBasePath: e.target.value }))}
                  placeholder="远程基础目录"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={saveWebDAVSettings}
                    disabled={savingWebDAV}
                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {savingWebDAV ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    保存配置
                  </button>
                  <button
                    onClick={testWebDAV}
                    disabled={testingWebDAV}
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {testingWebDAV ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube2 className="w-4 h-4" />}
                    测试连接
                  </button>
                  <button
                    onClick={() => listWebDAVDirectories(selectedRemoteDir)}
                    disabled={listingWebDAV}
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {listingWebDAV ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                    读取目录
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
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

                <div className="rounded-xl border border-gray-100 p-3 bg-gray-50">
                  <div className="text-sm font-semibold text-gray-800 mb-2">远程目录选择</div>
                  <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                    <span>当前远程目录: {selectedRemoteDir || '/'}</span>
                    <button
                      onClick={() => {
                        const parent = selectedRemoteDir.split('/').slice(0, -1).join('/');
                        listWebDAVDirectories(parent);
                      }}
                      className="px-2 py-1 rounded border border-gray-200 hover:bg-white"
                    >
                      返回上级
                    </button>
                  </div>
                  <div className="mb-2 text-xs text-gray-500">
                    手动上传会自动补成 `当前远程目录/YYYY/MM/DD/文件名`。
                  </div>
                  <div className="max-h-56 overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100 bg-white">
                    <div className="flex items-center justify-between p-2.5 bg-slate-50">
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
                          className="flex items-center gap-2 min-w-0 text-left"
                        >
                          {entry.is_dir ? <FolderOpen className="w-4 h-4 text-blue-600" /> : <File className="w-4 h-4 text-slate-400" />}
                          <span className="text-sm text-gray-700 truncate">{entry.name}</span>
                          {entry.is_dir && <ChevronRight className="w-4 h-4 text-gray-400" />}
                        </button>
                        <button
                          onClick={() => setSelectedRemoteDir(entry.is_dir ? entry.path : selectedRemoteDir)}
                          disabled={!entry.is_dir}
                          className={`px-2 py-1 text-xs rounded border ${entry.is_dir && selectedRemoteDir === entry.path ? 'bg-emerald-600 text-white border-emerald-600' : 'border-gray-200'} ${!entry.is_dir ? 'opacity-40 cursor-not-allowed' : 'hover:bg-emerald-50'}`}
                        >
                          选中
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    现在会显示远程目录和文件。目录可以进入并选中，文件只展示不选中。
                  </div>
                  <div className="mt-3 rounded-xl border border-gray-100 bg-white p-3 space-y-2">
                    <div className="text-sm font-semibold text-gray-800">远程目录操作</div>
                    <div className="text-xs text-gray-500">当前选中: {selectedRemoteEntryPath || '未选择'}</div>
                    <div className="flex gap-2">
                      <input
                        value={newRemoteFolderName}
                        onChange={(e) => setNewRemoteFolderName(e.target.value)}
                        placeholder="新建远程文件夹名称"
                        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                      />
                      <button
                        onClick={handleCreateRemoteFolder}
                        disabled={creatingRemoteFolder}
                        className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                      >
                        {creatingRemoteFolder ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
                        新建
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={renameRemoteName}
                        onChange={(e) => setRenameRemoteName(e.target.value)}
                        placeholder="重命名远程选中项"
                        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                      />
                      <button
                        onClick={handleRenameRemote}
                        disabled={renamingRemote || !selectedRemoteEntryPath}
                        className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {renamingRemote ? <Loader2 className="w-4 h-4 animate-spin" /> : <PencilLine className="w-4 h-4" />}
                          重命名
                        </button>
                        <button
                          onClick={handleDeleteRemote}
                          disabled={deletingRemote || !selectedRemoteEntryPath}
                          className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm flex items-center gap-2 disabled:opacity-50"
                        >
                          {deletingRemote ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          删除
                        </button>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleUploadToWebDAV}
                  disabled={!selectedPath || uploadingWebDAV}
                  className="w-full px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {uploadingWebDAV ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  上传当前文件到 WebDAV
                </button>
              </div>
            </section>
          </div>

          <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-800">字幕编辑器</h3>
                  <p className="text-sm text-gray-500 mt-1">先编辑 `.srt`，确认没问题后再做内嵌字幕。</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleDownloadSubtitle('srt')}
                    disabled={subtitleCues.length === 0}
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 flex items-center gap-2 disabled:opacity-50"
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
                    className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700"
                  >
                  新增字幕
                </button>
                <button
                  onClick={handleSaveSubtitleFile}
                  disabled={savingSubtitleFile || !subtitleFilePath}
                  className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {savingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  保存字幕
                </button>
              </div>
            </div>

            <div className="flex gap-3 mb-4">
              <input
                value={subtitleFilePath}
                onChange={(e) => setSubtitleFilePath(e.target.value)}
                placeholder="字幕文件路径，例如 transformed/2026/04/19/xxx_tr.srt"
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none"
              />
              <button
                onClick={handleLoadSubtitleEditor}
                disabled={!selectedPath || loadingSubtitleFile}
                className="px-3 py-2 rounded-lg border border-gray-200 text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {loadingSubtitleFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                读取字幕
              </button>
            </div>

            <div className="text-xs text-gray-500 mb-3">
              默认会按当前视频自动推断同名 `.srt` 路径。时间格式使用 `00:00:12,345`。
            </div>

            <div className="space-y-3 max-h-[520px] overflow-auto">
              {subtitleCues.length === 0 ? (
                <div className="text-sm text-gray-500 rounded-xl border border-dashed border-gray-200 p-4">
                  还没有载入字幕。先生成 `.srt`，或者直接输入字幕路径后点击“读取字幕”。
                </div>
              ) : (
                subtitleCues.map((cue, index) => (
                  <div
                    key={`${cue.index}-${index}`}
                    className={`rounded-xl border p-4 ${activeSubtitleIndex === index ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50/60'}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
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
                          className="px-2 py-1 rounded border border-gray-200 text-gray-600 text-xs"
                        >
                          跳转
                        </button>
                        <button
                          onClick={() => removeSubtitleCue(index)}
                          className="px-2 py-1 rounded border border-red-200 text-red-600 text-xs"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <input
                        value={cue.start}
                        onChange={(e) => updateSubtitleCue(index, 'start', e.target.value)}
                        placeholder="开始时间"
                        className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
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
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none resize-y"
                    />
                  </div>
                ))
              )}
            </div>

            <div className="mt-5 pt-5 border-t border-gray-100">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h4 className="text-base font-bold text-gray-800">内嵌字幕导出</h4>
                  <p className="text-sm text-gray-500 mt-1">把当前 `.srt` 烧录进视频画面，输出一个新的 `_sub.mp4` 文件。</p>
                </div>
                <button
                  onClick={handleBurnSubtitleVideo}
                  disabled={!selectedPath || !subtitleFilePath || burningSubtitleVideo}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {burningSubtitleVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  生成内嵌字幕视频
                </button>
              </div>

              <div className="grid grid-cols-5 gap-3">
                <input
                  value={burnSettings.fontName}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, fontName: e.target.value }))}
                  placeholder="字体名称"
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number"
                  min={10}
                  max={72}
                  value={burnSettings.fontSize}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, fontSize: Number(e.target.value) || defaultBurnSettings.fontSize }))}
                  placeholder="字号"
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={burnSettings.marginV}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, marginV: Number(e.target.value) || 0 }))}
                  placeholder="底边距"
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={burnSettings.outline}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, outline: Number(e.target.value) || 0 }))}
                  placeholder="描边"
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={burnSettings.shadow}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, shadow: Number(e.target.value) || 0 }))}
                  placeholder="阴影"
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3">
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
                <select
                  value={burnSettings.alignment}
                  onChange={(e) => setBurnSettings((prev) => ({ ...prev, alignment: Number(e.target.value) }))}
                  className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none"
                >
                  {subtitleAlignmentOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <HardDrive className="w-5 h-5 text-slate-500" />
              <h3 className="text-lg font-bold text-gray-800">目录规则</h3>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                <div className="font-semibold text-gray-800 mb-1">下载目录</div>
                <div className="text-gray-600 break-all">YYYY/MM/DD/文件.mp4</div>
              </div>
              <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                <div className="font-semibold text-gray-800 mb-1">转码目录</div>
                <div className="text-gray-600 break-all">transformed/YYYY/MM/DD/文件_tr.mp4</div>
              </div>
              <div className="rounded-xl bg-gray-50 border border-gray-100 p-4">
                <div className="font-semibold text-gray-800 mb-1">手动上传</div>
                <div className="text-gray-600 break-all">远程目录/YYYY/MM/DD/文件.mp4</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
};
