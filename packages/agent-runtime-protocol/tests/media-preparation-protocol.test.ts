import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  parseMediaPreparationRequest,
  parsePreparedMediaReceipt,
  parseProtocolFrame,
} from '../src/index'

const operationId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const artifactId = '33333333-3333-4333-8333-333333333333'
const artifact = {
  artifactId,
  mediaType: 'video/mp4',
  byteLength: 24,
  sha256: 'a'.repeat(64),
  displayName: 'clip.mp4',
}

describe('media preparation protocol', () => {
  it('accepts exact prepare and abort host requests', () => {
    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: operationId,
          method: 'media.prepare',
          correlationId: documentId,
          params: {
            operationId,
            documentId,
            runId: 'run-1',
            artifact,
            strategy: 'frames',
          },
        }),
      ),
    ).toMatchObject({ method: 'media.prepare' })
    expect(
      parseProtocolFrame(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: 'request',
          id: operationId,
          method: 'media.prepare.abort',
          correlationId: documentId,
          params: { operationId, documentId },
        }),
      ),
    ).toMatchObject({ method: 'media.prepare.abort' })
  })

  it('rejects unknown fields, invalid scope and unsupported strategies', () => {
    const valid = { operationId, documentId, runId: 'run-1', artifact, strategy: 'frames' }
    for (const value of [
      { ...valid, extra: true },
      { ...valid, documentId: 'bad' },
      { ...valid, strategy: 'cloud' },
      { ...valid, artifact: { ...artifact, sha256: 'bad' } },
    ]) {
      expect(() => parseMediaPreparationRequest(value)).toThrow('media_preparation_request_invalid')
    }
  })

  it('validates image, native and ordered frame receipts as distinct shapes', () => {
    expect(
      parsePreparedMediaReceipt({
        operationId,
        inputKind: 'image',
        strategy: 'image',
        artifacts: [{ ...artifact, mediaType: 'image/png' }],
      }),
    ).toMatchObject({ strategy: 'image' })
    expect(
      parsePreparedMediaReceipt({
        operationId,
        inputKind: 'audio',
        strategy: 'native',
        durationMs: 1_000,
        artifacts: [{ ...artifact, mediaType: 'audio/wav' }],
      }),
    ).toMatchObject({ inputKind: 'audio' })
    expect(
      parsePreparedMediaReceipt({
        operationId,
        inputKind: 'video',
        strategy: 'frames',
        durationMs: 2_000,
        artifacts: [
          { ...artifact, artifactId, mediaType: 'image/png' },
          {
            ...artifact,
            artifactId: '44444444-4444-4444-8444-444444444444',
            mediaType: 'image/png',
          },
        ],
        timestampsMs: [500, 1_500],
      }),
    ).toMatchObject({ timestampsMs: [500, 1_500] })
  })

  it.each([
    {
      operationId,
      inputKind: 'image',
      strategy: 'image',
      durationMs: 1,
      artifacts: [{ ...artifact, mediaType: 'image/png' }],
    },
    {
      operationId,
      inputKind: 'audio',
      strategy: 'native',
      durationMs: 1,
      artifacts: [{ ...artifact, mediaType: 'video/mp4' }],
    },
    {
      operationId,
      inputKind: 'video',
      strategy: 'frames',
      durationMs: 2_000,
      artifacts: [{ ...artifact, mediaType: 'image/png' }],
      timestampsMs: [2_001],
    },
    {
      operationId,
      inputKind: 'video',
      strategy: 'frames',
      durationMs: 2_000,
      artifacts: [
        { ...artifact, mediaType: 'image/png' },
        {
          ...artifact,
          artifactId: '44444444-4444-4444-8444-444444444444',
          mediaType: 'image/png',
        },
      ],
      timestampsMs: [500, 500],
    },
  ])('rejects malformed cross-field receipt %#', (value) => {
    expect(() => parsePreparedMediaReceipt(value)).toThrow('prepared_media_receipt_invalid')
  })
})
