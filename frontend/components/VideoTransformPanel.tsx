import { Loader2, RefreshCw, Wand2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { bridge } from '../services/bridge';
import { toast } from './Toast';

interface VideoFileItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

const defaultArgs = '-filter_complex "rotate=1*PI/180,eq=brightness=0.02:saturation=1.05,scale=1080:-2" -c:v libx264 -crf 23 -preset fast -c:a aac';

const formatSize = (bytes: number) => {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
};

export const VideoTransformPanel: React.FC = () => {
  const [files, setFiles] = useState<VideoFileItem[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [ffmpegArgs, setFfmpegArgs] = useState(defaultArgs);
  const [loading, setLoading] = useState(false);
  const [transforming, setTransforming] = useState(false);

  const selectedFile = useMemo(() => files.find(f => f.path === selectedPath), [files, selectedPath]);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const list = await bridge.listVideoFiles();
      setFiles(list);
      if (list.length > 0 && !selectedPath) {
        setSelectedPath(list[0].path);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取视频列表失败');
    } finally {
      setLoading(false);
    }
  };

  const handleTransform = async () => {
    if (!selectedPath) {
      toast.error('请先选择一个视频');
      return;
    }

    setTransforming(true);
    try {
      const result = await bridge.transformVideo(selectedPath, ffmpegArgs);
      if (result.success && result.output_path) {
        toast.success(`转码完成：${result.output_path}`);
        await loadFiles();
      } else {
        toast.error(result.error || '转码失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '转码失败');
    } finally {
      setTransforming(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  return (
    <main className="flex-1 flex flex-col min-w-0 relative p-8 gap-6 overflow-y-auto">
      <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-800">视频转码</h2>
            <p className="text-sm text-gray-500 mt-1">从下载目录选择视频，自定义 ffmpeg 参数并输出为原名 + <code>_tr</code> 文件。</p>
          </div>
          <button
            onClick={loadFiles}
            disabled={loading}
            className="px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            刷新列表
          </button>
        </div>

        <div className="max-h-72 overflow-auto rounded-xl border border-gray-100 divide-y divide-gray-100">
          {files.length === 0 ? (
            <div className="text-sm text-gray-500 p-4">暂无可转码视频，请先下载视频文件。</div>
          ) : files.map(file => (
            <label key={file.path} className="flex items-center justify-between p-3 hover:bg-gray-50 cursor-pointer">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="radio"
                  name="video_file"
                  checked={selectedPath === file.path}
                  onChange={() => setSelectedPath(file.path)}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{file.name}</div>
                  <div className="text-xs text-gray-500 truncate">{file.path}</div>
                </div>
              </div>
              <div className="text-xs text-gray-500 ml-4 shrink-0">{formatSize(file.size)}</div>
            </label>
          ))}
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
        <label className="text-sm font-medium text-gray-700 block mb-2">ffmpeg 参数（不需要输入 -i 和输出文件）</label>
        <textarea
          value={ffmpegArgs}
          onChange={(e) => setFfmpegArgs(e.target.value)}
          rows={4}
          className="w-full px-3 py-2 border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-mono"
          placeholder='例如：-vf "hflip" -c:v libx264 -crf 23 -c:a aac'
        />

        <div className="mt-3 text-xs text-gray-500">
          示例命令预览：
          <code className="block mt-1 p-2 bg-gray-50 border border-gray-100 rounded">
            ffmpeg -i "{selectedFile?.path || 'input.mp4'}" {ffmpegArgs || '[你的参数]'} -y "{selectedFile?.name.replace(/(\.[^.]+)?$/, '_tr$1') || 'output_tr.mp4'}"
          </code>
        </div>

        <button
          onClick={handleTransform}
          disabled={!selectedPath || transforming}
          className="mt-4 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-sm font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {transforming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          开始转码
        </button>
      </section>
    </main>
  );
};
