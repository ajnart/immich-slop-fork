import { Kysely } from 'kysely';
import { AssetStatus } from 'src/enum.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser();
  const sut = ctx.get(StackRepository);
  const add = async (extension: string, changes = {}) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalFileName: `DSC0001.${extension}`,
      originalPath: `/upload/${extension}/DSC0001.${extension}`,
      fileCreatedAt: new Date('2026-01-02T03:04:05.000Z'),
      ...changes,
    });
    await ctx.newExif({
      assetId: asset.id,
      dateTimeOriginal: new Date('2026-01-02T03:04:05.000Z'),
      make: 'FUJIFILM',
      model: 'X-T5',
    });
    return asset;
  };
  return { ctx, user, sut, add };
};

describe('RAW companion persistence', () => {
  it.each([
    ['RAF', 'JPG'],
    ['JPG', 'RAF'],
    ['RAF', 'PNG'],
    ['PNG', 'RAF'],
  ])('pairs %s imported before %s with the rendered asset primary', async (firstExtension, secondExtension) => {
    const { ctx, sut, user, add } = await setup();
    const first = await add(firstExtension);
    await expect(sut.pairRawCompanion(first.id)).resolves.toBeUndefined();
    const second = await add(secondExtension);
    const pair = await sut.pairRawCompanion(second.id);
    const assets = [first, second];
    const raw = assets.find((asset) => asset.originalFileName.endsWith('.RAF'))!;
    const rendered = assets.find((asset) => !asset.originalFileName.endsWith('.RAF'))!;

    expect(pair).toEqual({
      rawId: raw.id,
      renderedId: rendered.id,
      ownerId: user.id,
      stackId: expect.any(String),
      created: true,
    });
    await expect(sut.getById(pair!.stackId!)).resolves.toMatchObject({
      primaryAssetId: rendered.id,
      assets: expect.arrayContaining([
        expect.objectContaining({ id: raw.id }),
        expect.objectContaining({ id: rendered.id }),
      ]),
    });
    const persisted = await ctx.database
      .selectFrom('asset')
      .selectAll()
      .where(
        'id',
        'in',
        assets.map((asset) => asset.id),
      )
      .execute();
    for (const original of assets) {
      expect(persisted.find((asset) => asset.id === original.id)).toMatchObject({
        originalPath: original.originalPath,
        originalFileName: original.originalFileName,
        checksum: original.checksum,
      });
    }
  });

  it('discovers a candidate without creating a stack until explicitly committed', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    await expect(sut.pairRawCompanion(raw.id, false)).resolves.toEqual({
      rawId: raw.id,
      renderedId: rendered.id,
      ownerId: user.id,
      stackId: null,
      created: false,
    });
    await expect(
      ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
    ).resolves.toEqual([]);
    await expect(sut.pairRawCompanion(raw.id)).resolves.toMatchObject({ created: true });
  });

  it.each(['DSCF_100%', 'trip.day.001', 'IMG[01]'])('pairs a literal filename stem %s', async (stem) => {
    const { sut, add } = await setup();
    const raw = await add('RAF', { originalFileName: `${stem}.RAF` });
    const rendered = await add('JPG', { originalFileName: `${stem}.JPG` });
    await add('PNG', { originalFileName: 'DSCFx100Q.PNG' });
    await expect(sut.pairRawCompanion(raw.id)).resolves.toMatchObject({ rawId: raw.id, renderedId: rendered.id });
  });

  it('does not ignore an ambiguous candidate whose metadata has not arrived', async () => {
    const { ctx, sut, add } = await setup();
    const raw = await add('RAF');
    await add('JPG');
    const uncertain = await add('PNG');
    await ctx.database.deleteFrom('asset_exif').where('assetId', '=', uncertain.id).execute();
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });

  it('does not commit a different rendered source after discovery', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const discovered = await sut.pairRawCompanion(raw.id, false);
    await ctx.database.deleteFrom('asset').where('id', '=', rendered.id).execute();
    await add('JPG');
    await expect(sut.pairRawCompanion(raw.id, true, discovered!)).resolves.toBeUndefined();
    await expect(
      ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
    ).resolves.toEqual([]);
  });

  it('preserves a manual stack created between discovery and commit', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const discovered = await sut.pairRawCompanion(raw.id, false);
    const { stack } = await ctx.newStack({ ownerId: user.id }, [raw.id, rendered.id]);
    await expect(sut.pairRawCompanion(raw.id, true, discovered!)).resolves.toBeUndefined();
    await expect(sut.getById(stack.id)).resolves.toMatchObject({ primaryAssetId: raw.id });
  });

  it('serializes simultaneous jobs and keeps retries idempotent', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const results = await Promise.all([
      sut.pairRawCompanion(raw.id),
      sut.pairRawCompanion(rendered.id),
      sut.pairRawCompanion(raw.id),
    ]);
    expect(results.every(Boolean)).toBe(true);
    expect(new Set(results.map((result) => result!.stackId)).size).toBe(1);
    expect(results.filter((result) => result!.created)).toHaveLength(1);
    await expect(
      ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
    ).resolves.toHaveLength(1);
  });

  it('does not match assets belonging to different owners', async () => {
    const { ctx, sut, add } = await setup();
    const { user: other } = await ctx.newUser();
    const raw = await add('RAF');
    await add('JPG', { ownerId: other.id });
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });

  it.each(['library', 'folder', 'source'])('does not pair across an external %s boundary', async (boundary) => {
    const { ctx, sut, user, add } = await setup();
    const library = await ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'First', importPaths: [], exclusionPatterns: [] });
    const otherLibrary = await ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'Second', importPaths: [], exclusionPatterns: [] });
    const raw = await add('RAF', {
      isExternal: true,
      libraryId: library.id,
      originalPath: '/library/trip/DSC0001.RAF',
    });
    const changes: { isExternal: boolean; libraryId: string | null; originalPath: string } = {
      isExternal: true,
      libraryId: library.id,
      originalPath: '/library/trip/DSC0001.JPG',
    };
    switch (boundary) {
      case 'library': {
        changes.libraryId = otherLibrary.id;
        break;
      }
      case 'folder': {
        changes.originalPath = '/library/other/DSC0001.JPG';
        break;
      }
      case 'source': {
        changes.libraryId = null;
        changes.isExternal = false;
        break;
      }
    }
    await add('JPG', changes);
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });

  it('pairs external assets in the same library and folder without camera metadata', async () => {
    const { ctx, sut, user, add } = await setup();
    const library = await ctx
      .get(LibraryRepository)
      .create({ ownerId: user.id, name: 'Camera files', importPaths: [], exclusionPatterns: [] });
    const raw = await add('RAF', {
      isExternal: true,
      libraryId: library.id,
      originalPath: '/library/trip/DSC0001.RAF',
    });
    const rendered = await add('JPG', {
      isExternal: true,
      libraryId: library.id,
      originalPath: '/library/trip/DSC0001.JPG',
    });
    await ctx.database
      .updateTable('asset_exif')
      .set({ dateTimeOriginal: null, make: null, model: null })
      .where('assetId', 'in', [raw.id, rendered.id])
      .execute();
    await expect(sut.pairRawCompanion(raw.id)).resolves.toMatchObject({ rawId: raw.id, renderedId: rendered.id });
  });

  it.each(['PNG', 'CR3'])('rejects an ambiguous additional %s candidate', async (extension) => {
    const { sut, add } = await setup();
    const raw = await add('RAF');
    await add('JPG');
    await add(extension);
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });

  it('does not replace or merge an existing manual stack', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const unrelated = await add('PNG', { originalFileName: 'OTHER.PNG' });
    const { stack } = await ctx.newStack({ ownerId: user.id }, [unrelated.id, rendered.id]);
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
    await expect(sut.getById(stack.id)).resolves.toMatchObject({
      primaryAssetId: unrelated.id,
      assets: expect.arrayContaining([
        expect.objectContaining({ id: rendered.id }),
        expect.objectContaining({ id: unrelated.id }),
      ]),
    });
    await expect(
      ctx.database.selectFrom('asset').select('stackId').where('id', '=', raw.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ stackId: null });
  });

  it('preserves a manual RAW primary even when its two members match', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const { stack } = await ctx.newStack({ ownerId: user.id }, [raw.id, rendered.id]);
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
    await expect(sut.getById(stack.id)).resolves.toMatchObject({ primaryAssetId: raw.id });
  });

  it('preserves an unstack action performed after companion discovery', async () => {
    const { ctx, sut, user, add } = await setup();
    const raw = await add('RAF');
    await add('JPG');
    const pair = await sut.pairRawCompanion(raw.id);
    expect(pair?.stackId).toBeTruthy();
    await sut.delete(pair!.stackId!);

    await expect(sut.pairRawCompanion(raw.id, true, pair)).resolves.toBeUndefined();
    await expect(
      ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
    ).resolves.toEqual([]);
  });

  it('accepts a concurrent automatic pair after initially unstacked discovery', async () => {
    const { sut, add } = await setup();
    const raw = await add('RAF');
    await add('JPG');
    const discovered = await sut.pairRawCompanion(raw.id, false);
    expect(discovered?.stackId).toBeNull();
    const committed = await sut.pairRawCompanion(raw.id);

    await expect(sut.pairRawCompanion(raw.id, true, discovered)).resolves.toEqual({ ...committed, created: false });
  });

  it('stops using a rendered companion when it is trashed', async () => {
    const { ctx, sut, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    await sut.pairRawCompanion(raw.id);
    await ctx.database
      .updateTable('asset')
      .set({ deletedAt: new Date(), status: AssetStatus.Trashed })
      .where('id', '=', rendered.id)
      .execute();
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
    await expect(
      ctx.database
        .selectFrom('asset')
        .select(['originalPath', 'checksum'])
        .where('id', '=', raw.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ originalPath: raw.originalPath, checksum: raw.checksum });
  });

  it('stops using a rendered companion after permanent deletion', async () => {
    const { ctx, sut, add } = await setup();
    const raw = await add('RAF');
    const rendered = await add('JPG');
    const pair = await sut.pairRawCompanion(raw.id);
    await sut.delete(pair!.stackId!);
    await ctx.database.deleteFrom('asset').where('id', '=', rendered.id).execute();
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });

  it.each(['raw', 'rendered'])('does not use an edited %s as a companion', async (edited) => {
    const { sut, add } = await setup();
    const raw = await add('RAF', { isEdited: edited === 'raw' });
    await add('JPG', { isEdited: edited === 'rendered' });
    await expect(sut.pairRawCompanion(raw.id)).resolves.toBeUndefined();
  });
});
