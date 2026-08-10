import { BrowserWindow } from 'electron'
import type { MediaFrameExtractor } from '@genoffice/electron-utils'

const EMPTY_PAGE =
  'data:text/html;charset=utf-8,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:; img-src data:;"><title>GenOffice Media Preparation</title>'

type FrameWindow = {
  loadURL(url: string): Promise<void>
  webContents: {
    executeJavaScript<T>(code: string, userGesture?: boolean): Promise<T>
  }
  destroy(): void
  isDestroyed(): boolean
}

export type ElectronVideoFrameExtractorOptions = {
  createWindow?: () => FrameWindow
}

type BrowserFrame = {
  pngBase64: string
  width: number
  height: number
  timestampMs: number
}

function extractionScript(base64: string, durationMs: number, maximumFrames: number): string {
  return `(async () => {
    const binary = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    const wait = (event) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('media_decode_timeout')), 15000);
      const done = () => { clearTimeout(timer); video.removeEventListener('error', failed); resolve(); };
      const failed = () => { clearTimeout(timer); video.removeEventListener(event, done); reject(new Error('media_decode_failed')); };
      video.addEventListener(event, done, { once: true });
      video.addEventListener('error', failed, { once: true });
    });
    try {
      await wait('loadedmetadata');
      if (!Number.isFinite(video.duration) || video.duration <= 0 || Math.abs(video.duration * 1000 - ${durationMs}) > 2000) {
        throw new Error('media_duration_mismatch');
      }
      const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const count = Math.max(1, Math.min(${maximumFrames}, Math.ceil(video.duration / 10)));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('media_canvas_unavailable');
      const frames = [];
      for (let index = 0; index < count; index += 1) {
        const timestampMs = Math.round(((index + 1) * ${durationMs}) / (count + 1));
        video.currentTime = timestampMs / 1000;
        await wait('seeked');
        context.drawImage(video, 0, 0, width, height);
        frames.push({
          pngBase64: canvas.toDataURL('image/png').slice('data:image/png;base64,'.length),
          width,
          height,
          timestampMs,
        });
      }
      return frames;
    } finally {
      URL.revokeObjectURL(url);
      video.remove();
    }
  })()`
}

function validFrame(value: unknown): value is BrowserFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (
    typeof frame.pngBase64 === 'string' &&
    frame.pngBase64.length > 0 &&
    Number.isInteger(frame.width) &&
    (frame.width as number) >= 1 &&
    (frame.width as number) <= 1_920 &&
    Number.isInteger(frame.height) &&
    (frame.height as number) >= 1 &&
    (frame.height as number) <= 1_080 &&
    Number.isInteger(frame.timestampMs) &&
    (frame.timestampMs as number) >= 0 &&
    Object.keys(frame).sort().join('\0') ===
      ['height', 'pngBase64', 'timestampMs', 'width'].sort().join('\0')
  )
}

export class ElectronVideoFrameExtractor implements MediaFrameExtractor {
  private readonly createWindow: () => FrameWindow

  constructor(options: ElectronVideoFrameExtractorOptions = {}) {
    this.createWindow =
      options.createWindow ??
      (() =>
        new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            offscreen: true,
          },
        }))
  }

  async extract(
    input: Parameters<MediaFrameExtractor['extract']>[0],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<MediaFrameExtractor['extract']>>> {
    if (signal.aborted) throw signal.reason
    const window = this.createWindow()
    const abort = () => {
      if (!window.isDestroyed()) window.destroy()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await window.loadURL(EMPTY_PAGE)
      if (signal.aborted) throw signal.reason
      const value: unknown = await window.webContents.executeJavaScript(
        extractionScript(
          Buffer.from(input.bytes).toString('base64'),
          input.durationMs,
          input.maximumFrames,
        ),
        false,
      )
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > input.maximumFrames ||
        !value.every(validFrame)
      ) {
        throw new Error('media_frame_result_invalid')
      }
      return value.map((frame) => ({
        bytes: Buffer.from(frame.pngBase64, 'base64'),
        width: frame.width,
        height: frame.height,
        timestampMs: frame.timestampMs,
      }))
    } finally {
      signal.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
