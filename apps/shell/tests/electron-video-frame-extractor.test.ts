import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ options: [] as unknown[] }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false
    webContents = {
      executeJavaScript: vi
        .fn()
        .mockResolvedValue([{ pngBase64: 'cG5n', width: 1, height: 1, timestampMs: 1 }]),
    }
    constructor(options: unknown) {
      electron.options.push(options)
    }
    loadURL = vi.fn().mockResolvedValue(undefined)
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    isDestroyed = () => this.destroyed
  },
}))

import { ElectronVideoFrameExtractor } from '../src/main/electron-video-frame-extractor'

function fixture(result: unknown) {
  const executeJavaScript = vi.fn().mockResolvedValue(result)
  const destroy = vi.fn()
  let destroyed = false
  destroy.mockImplementation(() => {
    destroyed = true
  })
  const window = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: { executeJavaScript },
    destroy,
    isDestroyed: () => destroyed,
  }
  return {
    extractor: new ElectronVideoFrameExtractor({ createWindow: () => window }),
    window,
    executeJavaScript,
  }
}

describe('ElectronVideoFrameExtractor', () => {
  it('decodes a validated bounded frame result in a sandboxed offscreen page', async () => {
    const png = Buffer.from('png')
    const { extractor, window, executeJavaScript } = fixture([
      { pngBase64: png.toString('base64'), width: 320, height: 180, timestampMs: 500 },
    ])
    await expect(
      extractor.extract(
        {
          bytes: Buffer.from('video'),
          mediaType: 'video/mp4',
          durationMs: 2_000,
          maximumFrames: 12,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ bytes: png, width: 320, height: 180, timestampMs: 500 }])
    expect(window.loadURL).toHaveBeenCalledWith(expect.stringContaining('Content-Security-Policy'))
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('video/mp4'), false)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it.each([
    [],
    [null],
    [[]],
    [{ pngBase64: '', width: 1, height: 1, timestampMs: 0 }],
    [{ pngBase64: 1, width: 1, height: 1, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 0, height: 1, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 1.5, height: 1, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 2_000, height: 1, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 1, height: 0, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 1, height: 1.5, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 1, height: 1_081, timestampMs: 0 }],
    [{ pngBase64: 'cG5n', width: 1, height: 1, timestampMs: -1 }],
    [{ pngBase64: 'cG5n', width: 1, height: 1, timestampMs: 0.5 }],
    [{ pngBase64: 'cG5n', width: 1, height: 1, timestampMs: 0, extra: true }],
    Array.from({ length: 13 }, (_, timestampMs) => ({
      pngBase64: 'cG5n',
      width: 1,
      height: 1,
      timestampMs,
    })),
  ])('rejects malformed browser output %# and destroys the window', async (result) => {
    const { extractor, window } = fixture(result)
    await expect(
      extractor.extract(
        {
          bytes: Buffer.from('video'),
          mediaType: 'video/mp4',
          durationMs: 2_000,
          maximumFrames: 12,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('media_frame_result_invalid')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the offscreen window when Stop aborts extraction', async () => {
    const controller = new AbortController()
    const { extractor, window } = fixture([])
    window.loadURL.mockImplementation(async () => {
      controller.abort(new Error('stopped'))
    })
    await expect(
      extractor.extract(
        {
          bytes: Buffer.from('video'),
          mediaType: 'video/mp4',
          durationMs: 2_000,
          maximumFrames: 12,
        },
        controller.signal,
      ),
    ).rejects.toThrow('stopped')
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a pre-aborted request before creating a window', async () => {
    const createWindow = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(
      new ElectronVideoFrameExtractor({ createWindow }).extract(
        {
          bytes: Buffer.from('video'),
          mediaType: 'video/mp4',
          durationMs: 2_000,
          maximumFrames: 12,
        },
        controller.signal,
      ),
    ).rejects.toThrow('stopped')
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('creates the production BrowserWindow with the sandboxed offscreen options', async () => {
    electron.options.length = 0
    await new ElectronVideoFrameExtractor().extract(
      { bytes: Buffer.from('video'), mediaType: 'video/mp4', durationMs: 2_000, maximumFrames: 12 },
      new AbortController().signal,
    )
    expect(electron.options).toEqual([
      {
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
        },
      },
    ])
  })
})
