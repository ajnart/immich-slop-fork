import { dirname, extname } from 'node:path';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export interface RawCompanionAsset {
  id: string;
  ownerId: string;
  libraryId: string | null;
  isExternal: boolean;
  originalPath: string;
  originalFileName: string;
  fileCreatedAt: Date | string;
  stackId: string | null;
  deletedAt: Date | string | null;
  isOffline: boolean;
  isEdited: boolean;
  isFavorite: boolean;
  type: AssetType;
  visibility: AssetVisibility;
  livePhotoVideoId?: string | null;
  status?: AssetStatus;
  exifInfo: {
    make: string | null;
    model: string | null;
    dateTimeOriginal: Date | string | null;
  };
}

const stem = (name: string) => name.slice(0, -extname(name).length);
const isRendered = (name: string) => ['.jpg', '.jpeg', '.png'].includes(extname(name).toLowerCase());
export const isRawCompanion = (name: string) => mimeTypes.isRaw(name) || isRendered(name);

export function findRawCompanionPair(asset: RawCompanionAsset, candidates: RawCompanionAsset[]) {
  const matches = candidates.filter((candidate) => {
    if (
      candidate.ownerId !== asset.ownerId ||
      candidate.libraryId !== asset.libraryId ||
      candidate.isExternal !== asset.isExternal ||
      stem(candidate.originalFileName) !== stem(asset.originalFileName) ||
      !isRawCompanion(candidate.originalFileName)
    ) {
      return false;
    }

    if (asset.isExternal) {
      return dirname(candidate.originalPath) === dirname(asset.originalPath);
    }

    const date = asset.exifInfo.dateTimeOriginal;
    const candidateDate = candidate.exifInfo.dateTimeOriginal;
    if (!date) {
      return false;
    }
    return !candidateDate || new Date(date).getTime() === new Date(candidateDate).getTime();
  });

  if (matches.length !== 2 || matches.every(({ id }) => id !== asset.id)) {
    return;
  }

  if (
    matches.some(
      (candidate) =>
        candidate.deletedAt ||
        candidate.isOffline ||
        candidate.isEdited ||
        candidate.livePhotoVideoId ||
        (candidate.status && candidate.status !== AssetStatus.Active) ||
        candidate.type !== AssetType.Image ||
        ![AssetVisibility.Timeline, AssetVisibility.Archive].includes(candidate.visibility),
    )
  ) {
    return;
  }

  const raw = matches.find((candidate) => mimeTypes.isRaw(candidate.originalFileName));
  const rendered = matches.find((candidate) => isRendered(candidate.originalFileName));
  if (
    !raw ||
    !rendered ||
    raw.stackId !== rendered.stackId ||
    raw.visibility !== rendered.visibility ||
    raw.isFavorite !== rendered.isFavorite
  ) {
    return;
  }

  for (const key of ['make', 'model', 'dateTimeOriginal'] as const) {
    const left = raw.exifInfo[key];
    const right = rendered.exifInfo[key];
    if (!asset.isExternal && (!left || !right)) {
      return;
    }
    if (left && right) {
      if (key === 'dateTimeOriginal') {
        if (new Date(left).getTime() !== new Date(right).getTime()) {
          return;
        }
      } else if (left !== right) {
        return;
      }
    }
  }

  return { raw, rendered };
}
