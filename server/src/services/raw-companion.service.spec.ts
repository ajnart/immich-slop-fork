import type { JobItem, JobOf } from 'src/types.js';
import { AssetFileType, Colorspace, JobName, JobStatus, QueueName } from 'src/enum.js';
import { JobService } from 'src/services/job.service.js';
import { MediaService } from 'src/services/media.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { personThumbnailStub } from 'test/fixtures/person.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const raw = AssetFactory.from({ originalFileName: 'DSC0001.RAF', originalPath: '/original/DSC0001.RAF' })
  .exif()
  .build();
const rendered = AssetFactory.from({
  ownerId: raw.ownerId,
  originalFileName: 'DSC0001.JPG',
  originalPath: '/original/DSC0001.JPG',
})
  .exif()
  .build();
const pair = { rawId: raw.id, renderedId: rendered.id, ownerId: raw.ownerId, stackId: newUuid(), created: true };

describe('RAW companion thumbnail processing', () => {
  let sut: MediaService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MediaService));
    vi.stubEnv('IMMICH_RAW_COMPANIONS', undefined);
    mocks.person.getFaces.mockResolvedValue([]);
    mocks.ocr.getByAssetId.mockResolvedValue([]);
    mocks.media.decodeImage.mockResolvedValue({
      data: Buffer.from('pixels'),
      info: { width: 100, height: 100, channels: 3 },
    });
    mocks.media.getImageMetadata.mockResolvedValue({ width: 100, height: 100, isTransparent: false });
    mocks.assetJob.getForGenerateThumbnailJob.mockImplementation((id) => {
      if (id === raw.id) {
        return Promise.resolve(getForGenerateThumbnail(raw));
      }
      if (id === rendered.id) {
        return Promise.resolve(getForGenerateThumbnail(rendered));
      }
      return Promise.resolve(undefined);
    });
    mocks.stack.pairRawCompanion.mockResolvedValue(pair);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves normal RAW processing when explicitly disabled', async () => {
    vi.stubEnv('IMMICH_RAW_COMPANIONS', 'false');
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.stack.pairRawCompanion).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(raw.originalPath, expect.any(Object));
  });

  it.each([undefined, 'true', '1', ''])('uses the rendered companion when the setting is %s', async (setting) => {
    vi.stubEnv('IMMICH_RAW_COMPANIONS', setting);
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.stack.pairRawCompanion).toHaveBeenLastCalledWith(raw.id, true, pair);
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(rendered.originalPath, expect.any(Object));
  });

  it('decodes only the rendered source and saves derivatives under the RAW asset', async () => {
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.media.extract).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(rendered.originalPath, expect.any(Object));
    expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
      expect.objectContaining({ assetId: raw.id, type: AssetFileType.Preview, path: expect.stringContaining(raw.id) }),
      expect.objectContaining({
        assetId: raw.id,
        type: AssetFileType.Thumbnail,
        path: expect.stringContaining(raw.id),
      }),
    ]);
    expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
    expect(mocks.stack.pairRawCompanion).toHaveBeenLastCalledWith(raw.id, true, pair);
    for (const [update] of mocks.asset.update.mock.calls) {
      expect(update).not.toHaveProperty('originalPath');
      expect(update).not.toHaveProperty('checksum');
      expect(update).not.toHaveProperty('width');
      expect(update).not.toHaveProperty('height');
    }
  });

  it('uses the rendered colorspace and orientation without inheriting RAW orientation', async () => {
    const rawJob = getForGenerateThumbnail(raw);
    const renderedJob = getForGenerateThumbnail(rendered);
    rawJob.exifInfo = { ...rawJob.exifInfo, orientation: '6', profileDescription: 'Adobe RGB' };
    renderedJob.exifInfo = { ...renderedJob.exifInfo, orientation: '1', profileDescription: 'sRGB' };
    mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValueOnce(rawJob).mockResolvedValueOnce(renderedJob);
    await sut.handleGenerateThumbnails({ id: raw.id });
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(
      rendered.originalPath,
      expect.objectContaining({
        colorspace: Colorspace.Srgb,
        orientation: undefined,
      }),
    );
  });

  it('generates an independently owned RAW fullsize file from the rendered source', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: true } } });
    await sut.handleGenerateThumbnails({ id: raw.id });
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(rendered.originalPath, expect.any(Object));
    expect(mocks.asset.upsertFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: raw.id,
          type: AssetFileType.FullSize,
          path: expect.stringContaining(raw.id),
        }),
      ]),
    );
  });

  it('does not create a stack if persisting derivatives fails', async () => {
    const data: JobOf<JobName.AssetGenerateThumbnails> = { id: raw.id };
    mocks.asset.upsertFiles.mockRejectedValue(new Error('write failed'));
    await expect(sut.handleGenerateThumbnails(data)).rejects.toThrow('write failed');
    expect(mocks.stack.pairRawCompanion).toHaveBeenCalledExactlyOnceWith(raw.id, false);
    expect(mocks.event.emit).not.toHaveBeenCalledWith('StackCreate', expect.any(Object));
    expect(data.notify).toBeUndefined();
  });

  it('uses the RAW-owned preview for person thumbnails without decoding RAW again', async () => {
    const data = { ...personThumbnailStub.rawEmbeddedThumbnail, originalPath: raw.originalPath };
    mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(data);
    await expect(sut.handleGeneratePersonThumbnail({ ownerId: raw.ownerId, personGroupId: newUuid() })).resolves.toBe(
      JobStatus.Success,
    );
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(data.previewPath, expect.any(Object));
    expect(mocks.media.extract).not.toHaveBeenCalled();
  });

  it('restores original RAW person-thumbnail processing when explicitly disabled', async () => {
    vi.stubEnv('IMMICH_RAW_COMPANIONS', 'false');
    mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: false } });
    const data = { ...personThumbnailStub.rawEmbeddedThumbnail, originalPath: raw.originalPath };
    mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(data);
    await sut.handleGeneratePersonThumbnail({ ownerId: raw.ownerId, personGroupId: newUuid() });
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(raw.originalPath, expect.any(Object));
  });

  it.each([pair, undefined])(
    'refreshes analysis and clients after RAW-only regeneration with pair %j',
    async (committed) => {
      mocks.stack.pairRawCompanion.mockResolvedValueOnce(pair).mockResolvedValueOnce(committed);
      const { sut: jobService, mocks: jobMocks } = newTestService(JobService);
      const job: JobItem = { name: JobName.AssetGenerateThumbnails, data: { id: raw.id } };
      jobMocks.job.run.mockImplementation(async (item) => {
        if (item.name === JobName.AssetGenerateThumbnails) {
          return sut.handleGenerateThumbnails(item.data);
        }
      });
      jobMocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([raw]);

      await jobService.onJobRun(QueueName.ThumbnailGeneration, job);

      expect(job.data.notify).toBe(true);
      expect(jobMocks.job.queueAll).toHaveBeenCalledExactlyOnceWith([
        { name: JobName.SmartSearch, data: job.data },
        { name: JobName.AssetDetectFaces, data: job.data },
        { name: JobName.Ocr, data: job.data },
      ]);
      expect(jobMocks.websocket.clientSend).toHaveBeenCalledWith(
        'AssetUploadReadyV2',
        raw.ownerId,
        expect.objectContaining({ asset: expect.objectContaining({ id: raw.id }) }),
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(jobMocks.job.queue).not.toHaveBeenCalled();
    },
  );

  it('queues RAW regeneration after a rendered companion succeeds', async () => {
    await expect(sut.handleGenerateThumbnails({ id: rendered.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.AssetGenerateThumbnails,
      data: { id: raw.id, notify: true },
    });
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(rendered.originalPath, expect.any(Object));
  });

  it('falls back to RAW processing when no safe pair exists', async () => {
    mocks.stack.pairRawCompanion.mockResolvedValue(undefined);
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(raw.originalPath, expect.any(Object));
  });

  it('falls back when the rendered asset is deleted before its job data is loaded', async () => {
    mocks.assetJob.getForGenerateThumbnailJob
      .mockResolvedValueOnce(getForGenerateThumbnail(raw))
      .mockResolvedValueOnce(undefined);
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(raw.originalPath, expect.any(Object));
  });

  it('falls back when the rendered file is missing or cannot be decoded', async () => {
    const data: JobOf<JobName.AssetGenerateThumbnails> = { id: raw.id };
    mocks.media.decodeImage.mockRejectedValueOnce(new Error('ENOENT: rendered file missing'));
    await expect(sut.handleGenerateThumbnails(data)).resolves.toBe(JobStatus.Success);
    expect(mocks.media.decodeImage.mock.calls.map(([source]) => source)).toEqual([
      rendered.originalPath,
      raw.originalPath,
    ]);
    expect(mocks.stack.pairRawCompanion).toHaveBeenCalledExactlyOnceWith(raw.id, false);
    expect(mocks.event.emit).not.toHaveBeenCalledWith('StackCreate', expect.any(Object));
    expect(data.notify).toBeUndefined();
  });

  it('falls back when pairing fails without preventing ordinary processing', async () => {
    mocks.stack.pairRawCompanion.mockRejectedValue(new Error('pair transaction failed'));
    await expect(sut.handleGenerateThumbnails({ id: raw.id })).resolves.toBe(JobStatus.Success);
    expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(raw.originalPath, expect.any(Object));
  });

  it('does not queue RAW regeneration when rendered generation fails', async () => {
    mocks.media.decodeImage.mockRejectedValue(new Error('invalid rendered image'));
    await expect(sut.handleGenerateThumbnails({ id: rendered.id })).rejects.toThrow('invalid rendered image');
    expect(mocks.job.queue).not.toHaveBeenCalledWith({
      name: JobName.AssetGenerateThumbnails,
      data: { id: raw.id, notify: true },
    });
  });
});
