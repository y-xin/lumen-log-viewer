// 根级错误边界：捕获 render / lifecycle / effect 抛出的异常，避免整页白屏
// 开发模式下展开 stack 协助 debug；生产模式只给重新加载按钮

import { Component, ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode; }

interface State {
  hasError: boolean;
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 本地 console — Tauri WKWebView 里可在调试器看到
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
    this.setState({ info });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null, info: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    const { error, info } = this.state;
    const isDev = import.meta.env.DEV;
    return (
      <div className="fixed inset-0 z-50 bg-slate-50 flex items-center justify-center p-6 overflow-auto">
        <div className="bg-white border border-red-200 rounded shadow-lg max-w-2xl w-full p-6">
          <h2 className="text-base font-semibold text-red-700 mb-2">应用崩溃</h2>
          <p className="text-sm text-slate-600 mb-3">渲染出了未捕获的异常。可以尝试恢复或重新加载。</p>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-2 mb-3 text-xs font-mono text-red-800 break-all">
              {error.message || String(error)}
            </div>
          )}
          {isDev && info && (
            <details className="mb-3 text-xs text-slate-500">
              <summary className="cursor-pointer hover:text-slate-700">组件栈（dev only）</summary>
              <pre className="mt-2 p-2 bg-slate-100 rounded whitespace-pre-wrap break-all">
                {info.componentStack}
              </pre>
            </details>
          )}
          <div className="flex gap-2">
            <button onClick={this.handleReset} className="ctl">尝试恢复</button>
            <button onClick={this.handleReload} className="ctl ctl-primary">重新加载</button>
          </div>
        </div>
      </div>
    );
  }
}
