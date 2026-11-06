import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { extname } from 'node:path';
import type { ExpressionBuilder, Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { StackTable } from 'src/schema/tables/stack.table.js';
import { asUuid, withDefaultVisibility, withExif } from 'src/utils/database.js';
import { findRawCompanionPair, isRawCompanion } from 'src/utils/raw-companion.js';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .selectAll('asset')
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset_exif')
            .select(columns.exif)
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('exifInfo'),
        (join) => join.onTrue(),
      )
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo'))
      .where('asset.deletedAt', 'is', null)
      .whereRef('asset.stackId', '=', 'stack.id')
      .$call(withDefaultVisibility)
      .orderBy('asset.fileCreatedAt', 'asc'),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async pairRawCompanion(
    id: string,
    create = true,
    expected?: { rawId: string; renderedId: string; stackId?: string | null },
  ) {
    return this.db.transaction().execute(async (tx) => {
      const asset = await tx.selectFrom('asset').selectAll().where('id', '=', id).executeTakeFirst();
      if (!asset || !isRawCompanion(asset.originalFileName)) {
        return;
      }

      const name = asset.originalFileName.slice(0, -extname(asset.originalFileName).length);
      const pattern = `${name.replaceAll(/[\\%_]/g, (character) => `\\${character}`)}.%`;
      const query = tx
        .selectFrom('asset')
        .selectAll('asset')
        .$call(withExif)
        .where('asset.ownerId', '=', asset.ownerId)
        .where('asset.libraryId', 'is not distinct from', asset.libraryId)
        .where('asset.isExternal', '=', asset.isExternal)
        .where(sql<string>`f_unaccent(asset."originalFileName")`, 'like', sql<string>`f_unaccent(${pattern})`)
        .$if(!asset.isExternal, (qb) => qb.where('asset.fileCreatedAt', '=', asset.fileCreatedAt))
        .orderBy('asset.id');
      const findPair = (rows: Awaited<ReturnType<typeof query.execute>>) => {
        const candidates = rows.map((row) => ({
          ...row,
          exifInfo: row.exifInfo ?? { make: null, model: null, dateTimeOriginal: null },
        }));
        const current = candidates.find((candidate) => candidate.id === id);
        if (current) {
          return findRawCompanionPair(current, candidates);
        }
      };

      let pair = findPair(await query.execute());
      if (!pair) {
        return;
      }

      if (create) {
        await tx.selectFrom('user').select('id').where('id', '=', asset.ownerId).forNoKeyUpdate().execute();
        pair = findPair(await query.forUpdate('asset').execute());
        if (!pair) {
          return;
        }
      }

      const { raw, rendered } = pair;
      if (expected && (expected.rawId !== raw.id || expected.renderedId !== rendered.id)) {
        return;
      }
      if (expected?.stackId && expected.stackId !== raw.stackId) {
        return;
      }
      let stackId = raw.stackId;
      let created = false;
      if (stackId) {
        const stack = await tx
          .selectFrom('stack')
          .select('primaryAssetId')
          .where('id', '=', stackId)
          .executeTakeFirst();
        const members = await tx.selectFrom('asset').select('id').where('stackId', '=', stackId).execute();
        if (stack?.primaryAssetId !== rendered.id || members.length !== 2) {
          return;
        }
      } else if (create) {
        const stack = await tx
          .insertInto('stack')
          .values({ ownerId: asset.ownerId, primaryAssetId: rendered.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        stackId = stack.id;
        await tx.updateTable('asset').set({ stackId }).where('id', 'in', [raw.id, rendered.id]).execute();
        created = true;
      }

      return { rawId: raw.id, renderedId: rendered.id, stackId, ownerId: asset.ownerId, created };
    });
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }] })
  search(query: StackSearch) {
    return this.db
      .selectFrom('stack')
      .selectAll('stack')
      .select(withAssets)
      .where('stack.ownerId', '=', query.ownerId)
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .execute();
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('user').select('id').where('id', '=', entity.ownerId).forNoKeyUpdate().execute();

      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      return tx
        .selectFrom('stack')
        .selectAll('stack')
        .select(withAssets)
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  update(id: string, entity: Updateable<StackTable>) {
    return this.db
      .updateTable('stack')
      .set(entity)
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .returning((eb) => withAssets(eb, true))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db
      .selectFrom('stack')
      .selectAll()
      .select((eb) => withAssets(eb, true))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }
}
