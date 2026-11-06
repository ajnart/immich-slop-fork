import { describe, expect, it } from 'vitest';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { RawCompanionAsset, findRawCompanionPair } from 'src/utils/raw-companion.js';

const createAsset = (overrides: Partial<RawCompanionAsset> = {}): RawCompanionAsset => ({
  id: 'raw',
  ownerId: 'owner',
  libraryId: null,
  isExternal: false,
  originalPath: '/upload/owner/raw.RAF',
  originalFileName: 'DSCF0001.RAF',
  fileCreatedAt: new Date('2026-01-01T12:00:00.000Z'),
  stackId: null,
  deletedAt: null,
  isOffline: false,
  isEdited: false,
  type: AssetType.Image,
  visibility: AssetVisibility.Timeline,
  status: AssetStatus.Active,
  exifInfo: { make: 'FUJIFILM', model: 'X-T5', dateTimeOriginal: '2026-01-01T12:00:00.000Z' },
  ...overrides,
});

const createRendered = (overrides: Partial<RawCompanionAsset> = {}) =>
  createAsset({
    id: 'rendered',
    originalPath: '/upload/owner/rendered.jpg',
    originalFileName: 'DSCF0001.jpg',
    ...overrides,
  });

describe('findRawCompanionPair', () => {
  it.each(['jpg', 'JPEG', 'PnG'])('selects the %s companion as rendered primary', (extension) => {
    const raw = createAsset();
    const rendered = createRendered({ originalFileName: `DSCF0001.${extension}` });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
    expect(findRawCompanionPair(rendered, [rendered, raw])).toEqual({ raw, rendered });
  });

  it.each(['raf', 'RAF', 'RaW', 'cr3', 'NEF', 'arw', 'dng'])('recognizes %s RAW extensions', (extension) => {
    const raw = createAsset({ originalFileName: `DSCF0001.${extension}` });
    const rendered = createRendered();

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it('matches the original filename instead of the managed storage filename', () => {
    const raw = createAsset({ originalPath: '/upload/owner/a/b/uuid.raf' });
    const rendered = createRendered({ originalPath: '/upload/owner/c/d/other-uuid.jpeg' });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it.each(['DSCF.0001', 'DSCF..0001', 'DSCF[001](a)+$^', 'DSCF_100%'])(
    'compares the complete literal basename repeatedly: %s',
    (basename) => {
      const raw = createAsset({ originalFileName: `${basename}.RaF` });
      const rendered = createRendered({ originalFileName: `${basename}.JpEg` });
      const unrelated = createRendered({ id: 'unrelated', originalFileName: 'DSCF0001.jpg' });

      expect(findRawCompanionPair(raw, [raw, rendered, unrelated])).toEqual({ raw, rendered });
      expect(findRawCompanionPair(rendered, [unrelated, rendered, raw])).toEqual({ raw, rendered });
      expect(findRawCompanionPair(raw, [raw, rendered, unrelated])).toEqual({ raw, rendered });
    },
  );

  it.each(['dscf0001.jpg', 'DSCF0001-1.jpg', 'DSCF00010.jpg', 'DSCF0001.RAF.jpg'])(
    'does not treat %s as the same basename',
    (originalFileName) => {
      const raw = createAsset();

      expect(findRawCompanionPair(raw, [raw, createRendered({ originalFileName })])).toBeUndefined();
    },
  );

  it.each(['webp', 'heic', 'tiff', 'mp4', 'xmp'])('rejects a %s rendered companion', (extension) => {
    const raw = createAsset();

    expect(
      findRawCompanionPair(raw, [raw, createRendered({ originalFileName: `DSCF0001.${extension}` })]),
    ).toBeUndefined();
  });

  it('does not pair two rendered assets or two RAW assets', () => {
    const raw = createAsset();
    const rendered = createRendered();

    expect(findRawCompanionPair(raw, [raw, createAsset({ id: 'other-raw' })])).toBeUndefined();
    expect(findRawCompanionPair(rendered, [rendered, createRendered({ id: 'other-rendered' })])).toBeUndefined();
  });

  it.each<Partial<RawCompanionAsset>>([
    { ownerId: 'another-owner' },
    { libraryId: 'another-library' },
    { isExternal: true },
  ])('rejects a companion from a different source scope: %j', (overrides) => {
    const raw = createAsset();

    expect(findRawCompanionPair(raw, [raw, createRendered(overrides)])).toBeUndefined();
  });

  it('matches external assets only in the same library and directory', () => {
    const raw = createAsset({ libraryId: 'library', isExternal: true, originalPath: '/photos/trip/DSCF0001.RAF' });
    const rendered = createRendered({
      libraryId: 'library',
      isExternal: true,
      originalPath: '/photos/trip/DSCF0001.jpg',
    });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
    expect(
      findRawCompanionPair(raw, [raw, { ...rendered, originalPath: '/photos/other/DSCF0001.jpg' }]),
    ).toBeUndefined();
    expect(findRawCompanionPair(raw, [raw, { ...rendered, libraryId: 'other-library' }])).toBeUndefined();
  });

  it('ignores unrelated assets from other scopes when assessing ambiguity', () => {
    const raw = createAsset();
    const rendered = createRendered();
    const other = createRendered({ id: 'other-rendered', ownerId: 'other-owner' });

    expect(findRawCompanionPair(raw, [other, raw, rendered])).toEqual({ raw, rendered });
  });

  it.each(['raw', 'rendered'])('rejects an ambiguous pair with an extra %s', (kind) => {
    const raw = createAsset();
    const rendered = createRendered();
    let extra = createAsset({ id: 'extra' });
    if (kind === 'rendered') {
      extra = createRendered({ id: 'extra', originalFileName: 'DSCF0001.png' });
    }

    expect(findRawCompanionPair(raw, [raw, rendered, extra])).toBeUndefined();
    expect(findRawCompanionPair(rendered, [extra, rendered, raw])).toBeUndefined();
  });

  it('rejects a third same-basename candidate whose capture metadata is missing', () => {
    const raw = createAsset();
    const rendered = createRendered();
    const extra = createRendered({
      id: 'extra',
      originalFileName: 'DSCF0001.png',
      exifInfo: { make: null, model: null, dateTimeOriginal: null },
    });

    expect(findRawCompanionPair(raw, [raw, rendered, extra])).toBeUndefined();
    expect(findRawCompanionPair(rendered, [extra, rendered, raw])).toBeUndefined();
  });

  it('ignores a same-basename upload with a different valid capture timestamp', () => {
    const raw = createAsset();
    const rendered = createRendered();
    const extra = createRendered({
      id: 'different-capture',
      exifInfo: {
        make: 'FUJIFILM',
        model: 'X-T5',
        dateTimeOriginal: '2026-02-01T12:00:00.000Z',
      },
    });

    expect(findRawCompanionPair(raw, [raw, extra, rendered])).toEqual({ raw, rendered });
    expect(findRawCompanionPair(rendered, [rendered, extra, raw])).toEqual({ raw, rendered });
  });

  it.each([
    { make: 'Canon', model: 'X-T5' },
    { make: 'FUJIFILM', model: 'X-T4' },
  ])('rejects conflicting camera metadata: %j', (camera) => {
    const raw = createAsset();
    const exifInfo = { ...raw.exifInfo, ...camera };

    expect(findRawCompanionPair(raw, [raw, createRendered({ exifInfo })])).toBeUndefined();
  });

  it.each([{ make: null }, { model: null }, { make: '' }, { model: '' }, { dateTimeOriginal: null }])(
    'requires capture metadata to pair managed uploads: %j',
    (metadata) => {
      const raw = createAsset();
      const rendered = createRendered({ exifInfo: { ...raw.exifInfo, ...metadata } });

      expect(findRawCompanionPair(raw, [raw, rendered])).toBeUndefined();
      expect(findRawCompanionPair(rendered, [rendered, raw])).toBeUndefined();
    },
  );

  it('allows absent capture metadata for external assets in the same source directory', () => {
    const exifInfo = { make: null, model: null, dateTimeOriginal: null };
    const raw = createAsset({
      isExternal: true,
      libraryId: 'library',
      originalPath: '/photos/DSCF0001.RAF',
      exifInfo,
    });
    const rendered = createRendered({
      isExternal: true,
      libraryId: 'library',
      originalPath: '/photos/DSCF0001.jpg',
      exifInfo,
    });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it('does not use filesystem timestamps as capture evidence', () => {
    const raw = createAsset({ fileCreatedAt: '2026-01-02T12:00:00.000Z' });
    const rendered = createRendered();

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it('accepts equal timestamps represented as a Date and an ISO string', () => {
    const raw = createAsset();
    const rendered = createRendered({
      exifInfo: { ...raw.exifInfo, dateTimeOriginal: new Date('2026-01-01T12:00:00.000Z') },
    });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it.each(['2026-01-01T12:00:00.001Z', '2026-01-02T12:00:00.000Z', 'invalid'])(
    'rejects incompatible or invalid upload timestamps: %s',
    (dateTimeOriginal) => {
      const raw = createAsset();
      const rendered = createRendered({ exifInfo: { ...raw.exifInfo, dateTimeOriginal } });

      expect(findRawCompanionPair(raw, [raw, rendered])).toBeUndefined();
      expect(findRawCompanionPair(rendered, [rendered, raw])).toBeUndefined();
    },
  );

  it.each([
    { make: 'Canon' },
    { model: 'X-T4' },
    { dateTimeOriginal: '2026-01-01T12:00:00.001Z' },
    { dateTimeOriginal: 'invalid' },
  ])('rejects conflicting external capture metadata: %j', (metadata) => {
    const raw = createAsset({ isExternal: true, libraryId: 'library', originalPath: '/photos/DSCF0001.RAF' });
    const rendered = createRendered({
      isExternal: true,
      libraryId: 'library',
      originalPath: '/photos/DSCF0001.jpg',
      exifInfo: { ...raw.exifInfo, ...metadata },
    });

    expect(findRawCompanionPair(raw, [raw, rendered])).toBeUndefined();
  });

  it.each<Partial<RawCompanionAsset>>([
    { deletedAt: new Date('2026-01-02T00:00:00.000Z') },
    { isOffline: true },
    { isEdited: true },
    { type: AssetType.Video },
    { visibility: AssetVisibility.Hidden },
    { livePhotoVideoId: 'live-photo-video' },
    { status: AssetStatus.Trashed },
    { status: AssetStatus.Deleted },
  ])('rejects ineligible input assets and companions: %j', (overrides) => {
    const raw = createAsset();
    const rendered = createRendered();
    const ineligibleRaw = createAsset(overrides);

    expect(findRawCompanionPair(raw, [raw, createRendered(overrides)])).toBeUndefined();
    expect(findRawCompanionPair(ineligibleRaw, [ineligibleRaw, rendered])).toBeUndefined();
  });

  it.each([
    ['manual-stack', null],
    [null, 'manual-stack'],
    ['manual-stack', 'other-stack'],
  ])('preserves existing stack membership: %s / %s', (rawStackId, renderedStackId) => {
    const raw = createAsset({ stackId: rawStackId });
    const rendered = createRendered({ stackId: renderedStackId });

    expect(findRawCompanionPair(raw, [raw, rendered])).toBeUndefined();
  });

  it('recognizes a pair already belonging to the same stack', () => {
    const raw = createAsset({ stackId: 'existing-stack' });
    const rendered = createRendered({ stackId: 'existing-stack' });

    expect(findRawCompanionPair(raw, [raw, rendered])).toEqual({ raw, rendered });
  });

  it('does not change the source assets or candidate order', () => {
    const raw = createAsset();
    const rendered = createRendered();
    const candidates = [raw, rendered];
    const before = structuredClone(candidates);

    findRawCompanionPair(raw, candidates);

    expect(candidates).toEqual(before);
  });

  it('does not pair an asset with itself', () => {
    const raw = createAsset();

    expect(findRawCompanionPair(raw, [raw])).toBeUndefined();
  });
});
