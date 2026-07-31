import { Insertable, Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(StackRepository) };
};

type PairOptions = {
  jpeg?: Partial<Insertable<AssetTable>>;
  raw?: Partial<Insertable<AssetTable>>;
  jpegExif?: Partial<Insertable<AssetExifTable>>;
  rawExif?: Partial<Insertable<AssetExifTable>>;
};

const newRawPair = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, options: PairOptions = {}) => {
  const capturedAt = new Date('2026-07-18T22:26:06.000Z');
  const [{ asset: jpeg }, { asset: raw }] = await Promise.all([
    ctx.newAsset({
      ownerId,
      originalFileName: 'IMG_1234.JPG',
      originalPath: '/upload/IMG_1234.JPG',
      fileCreatedAt: capturedAt,
      localDateTime: capturedAt,
      ...options.jpeg,
    }),
    ctx.newAsset({
      ownerId,
      originalFileName: 'IMG_1234.RAF',
      originalPath: '/upload/IMG_1234.RAF',
      fileCreatedAt: capturedAt,
      localDateTime: capturedAt,
      ...options.raw,
    }),
  ]);

  await Promise.all([
    ctx.newExif({ assetId: jpeg.id, make: 'FUJIFILM', model: 'X-T5', ...options.jpegExif }),
    ctx.newExif({ assetId: raw.id, make: 'FUJIFILM', model: 'X-T5', ...options.rawExif }),
  ]);

  return { jpeg, raw };
};

const invalidPairs: Array<PairOptions & { name: string }> = [
  { name: 'different basenames', jpeg: { originalFileName: 'IMG_1235.JPG' } },
  { name: 'different capture times', jpeg: { fileCreatedAt: new Date('2026-07-18T22:26:07.000Z') } },
  { name: 'different camera models', jpegExif: { model: 'X-T4' } },
  { name: 'different visibility', jpeg: { visibility: AssetVisibility.Archive } },
];

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StackRepository.name, () => {
  describe('autoStackRawPair', () => {
    it.each(['RAF', 'RAW', 'CR3'])('should stack a .%s file under its matching JPEG', async (extension) => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { jpeg, raw } = await newRawPair(ctx, user.id, {
        raw: { originalFileName: `IMG_1234.${extension}` },
      });

      const stackId = await sut.autoStackRawPair(raw.id);

      expect(stackId).toBeDefined();
      await expect(
        ctx.database.selectFrom('stack').selectAll().where('id', '=', stackId!).executeTakeFirstOrThrow(),
      ).resolves.toEqual(expect.objectContaining({ id: stackId, ownerId: user.id, primaryAssetId: jpeg.id }));
      await expect(
        ctx.database
          .selectFrom('asset')
          .select(['id', 'stackId'])
          .where('id', 'in', [jpeg.id, raw.id])
          .orderBy('id')
          .execute(),
      ).resolves.toEqual([
        { id: [jpeg.id, raw.id].sort()[0], stackId },
        { id: [jpeg.id, raw.id].sort()[1], stackId },
      ]);
    });

    it('should create only one stack when both metadata events run concurrently', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { jpeg, raw } = await newRawPair(ctx, user.id, {
        jpeg: { originalFileName: 'DSCF0001.jpeg' },
        raw: { originalFileName: 'DSCF0001.raf' },
      });

      const results = await Promise.all([sut.autoStackRawPair(jpeg.id), sut.autoStackRawPair(raw.id)]);
      const stackIds = results.filter((id) => id !== undefined);

      expect(stackIds).toHaveLength(1);
      await expect(
        ctx.database.selectFrom('stack').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([{ id: stackIds[0] }]);
    });

    it('should leave existing manual stacks unchanged', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const [{ jpeg, raw }, { asset: other }] = await Promise.all([
        newRawPair(ctx, user.id),
        ctx.newAsset({ ownerId: user.id, originalFileName: 'other.jpg' }),
      ]);
      const { result: manualStack } = await ctx.newStack({ ownerId: user.id }, [jpeg.id, other.id]);

      await expect(sut.autoStackRawPair(raw.id)).resolves.toBeUndefined();
      await expect(
        ctx.database.selectFrom('stack').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([{ id: manualStack.id }]);
    });

    it.each(invalidPairs)('should not stack assets with $name', async ({ jpeg, raw, jpegExif, rawExif }) => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { raw: rawAsset } = await newRawPair(ctx, user.id, { jpeg, raw, jpegExif, rawExif });

      await expect(sut.autoStackRawPair(rawAsset.id)).resolves.toBeUndefined();
      await expect(
        ctx.database.selectFrom('stack').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });

    it('should not stack external-library assets from different directories', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const library = await ctx.database
        .insertInto('library')
        .values({
          ownerId: user.id,
          name: 'Photos',
          importPaths: ['/photos'],
          exclusionPatterns: [],
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const { raw } = await newRawPair(ctx, user.id, {
        jpeg: { libraryId: library.id, originalPath: '/photos/jpeg/IMG_1234.JPG' },
        raw: { libraryId: library.id, originalPath: '/photos/raw/IMG_1234.RAF' },
      });

      await expect(sut.autoStackRawPair(raw.id)).resolves.toBeUndefined();
      await expect(
        ctx.database.selectFrom('stack').select('id').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });
  });
});
