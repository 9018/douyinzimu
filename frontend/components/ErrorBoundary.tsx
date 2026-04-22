/**
 * 错误边界组件
 * 捕获子组件中的 JavaScript 错误，显示友好的错误提示，防止整个应用崩溃
 */

import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // 更新 state 使下一次渲染能够显示降级后的 UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 记录错误信息
    console.error('ErrorBoundary 捕获到错误:', error, errorInfo);

    // 更新状态
    this.setState({
      error,
      errorInfo,
    });

    // 调用外部错误处理函数
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = (): void => {
    // 重置错误状态
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReload = (): void => {
    // 重新加载页面
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // 如果提供了自定义降级 UI，使用它
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 默认错误 UI
      return (
        <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-8">
          <div className="max-w-2xl w-full bg-white rounded-2xl shadow-2xl p-8">
            {/* 错误图标 */}
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-10 h-10 text-red-600" />
              </div>
            </div>

            {/* 错误标题 */}
            <h1 className="text-3xl font-bold text-gray-900 text-center mb-4">
              哎呀，出错了
            </h1>

            {/* 错误描述 */}
            <p className="text-gray-600 text-center mb-8">
              应用遇到了一个意外错误。不用担心，您的数据是安全的。
            </p>

            {/* 错误详情（开发环境显示） */}
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="mb-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  错误详情（仅开发环境显示）
                </h3>
                <pre className="text-xs text-red-600 overflow-auto max-h-40">
                  {this.state.error.toString()}
                  {this.state.errorInfo && (
                    <>
                      {'\n\n'}
                      {this.state.errorInfo.componentStack}
                    </>
                  )}
                </pre>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-4 justify-center">
              <button
                onClick={this.handleReset}
                className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors shadow-md hover:shadow-lg"
              >
                <RefreshCw size={20} />
                重试
              </button>

              <button
                onClick={this.handleReload}
                className="flex items-center gap-2 px-6 py-3 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors shadow-md hover:shadow-lg"
              >
                <Home size={20} />
                重新加载
              </button>
            </div>

            {/* 帮助提示 */}
            <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h4 className="text-sm font-semibold text-blue-900 mb-2">
                💡 遇到问题？
              </h4>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• 尝试刷新页面或重启应用</li>
                <li>• 检查网络连接是否正常</li>
                <li>• 清除浏览器缓存后重试</li>
                <li>• 如果问题持续，请联系技术支持</li>
              </ul>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * 轻量级错误边界组件
 * 用于局部组件的错误捕获，显示简洁的错误提示
 */
interface LightErrorBoundaryProps {
  children: ReactNode;
  fallbackMessage?: string;
}

export class LightErrorBoundary extends Component<
  LightErrorBoundaryProps,
  { hasError: boolean; errorMessage: string | null }
> {
  constructor(props: LightErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; errorMessage: string | null } {
    return { hasError: true, errorMessage: error?.message || null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('LightErrorBoundary 捕获到错误:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center gap-2 text-red-800">
            <AlertTriangle size={20} />
            <span className="font-medium">
              {this.props.fallbackMessage || '该组件加载失败'}
            </span>
          </div>
          {this.state.errorMessage && (
            <div className="mt-2 text-xs text-red-700 break-all">
              {this.state.errorMessage}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
