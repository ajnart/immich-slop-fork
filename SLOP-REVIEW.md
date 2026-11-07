# RAW companion code review

Reviewed the fork-specific changes against upstream main `0cb2ab23b8c1669cc0a39e2247c62bdaceb0150d`, including matching, repository transactions, thumbnail ownership, job completion, tests, image publication, and browser evidence. Independent reviews used GPT-6.1 Sol high. The feature is reviewed in [fork PR #1](https://github.com/ajnart/immich-slop-fork/pull/1), based on the clean `review/upstream-main` branch because fork `main` already contains an earlier implementation. The minimal PR excludes documentation, demos, branding, and validation workflows.

Final reviewed feature source: [`681024b1a`](https://github.com/ajnart/immich-slop-fork/commit/681024b1aee414f8be8450f56b1fb24d9bac6837). Its complete diff against the clean upstream base is:

| Scope | Files | Added lines | Removed lines |
| --- | ---: | ---: | ---: |
| Production, configuration, UI, and mobile compatibility | 7 | 286 | 14 |
| Tests and fixtures | 8 | 916 | 3 |
| Generated OpenAPI and TypeScript SDK | 2 | 5 | 0 |
| **Total** | **17** | **1,207** | **17** |

The generated files came from the API-generation workflow. The final feature diff adds no source comments. `git diff --check` passed, and the schema and migration trees match the upstream base exactly.

## Fixed finding

**P2: reprocessing an existing RAW alone could leave search, faces, OCR, and clients stale.** The preview changed to the rendered companion, but a manual thumbnail job normally lacks the notification flag needed by the job-completion pipeline. The handler now sets that flag only after the companion-derived files and thumbnail hash are persisted. Regression tests invoke the real job completion handler, check all downstream work and the client event, and cover final pairing revalidation failure. The fix does not queue a repeating thumbnail job.

**Demo persistence:** the initial disposable Compose setup used an anonymous database volume. A stop/recreate cycle could retain media while losing the account and stack records. The setup now mounts a named database volume, and the browser workflow performs `down` without volume deletion followed by `up` before checking the existing account and pair.

## Reviewed safeguards

- Matching is scoped to owner, library, source type, filename stem, and capture metadata or external directory. Ambiguous candidates are rejected. No arbitrary filename-only grouping across users/directories.
- Existing edits, Live Photos, deleted/offline assets, incompatible stacks, and mismatched archive/favorite choices prevent pairing.
- A successful rendered decode precedes new stack creation. Missing or unreadable companions fall back to the RAW original.
- Final pairing re-reads candidates under the owner lock and checks the expected pair/stack identity. Native manual stack creation uses the same lock. Concurrent uploads cannot create duplicate overlapping stacks.
- Each original retains independent generated-file ownership. No original paths/checksums or source EXIF dimensions are rewritten. Companion deletion does not delete RAW-owned derivatives.
- Successful RAW preview changes refresh analysis and clients. The normal `image.rawCompanions` setting defaults to true. Turning off **Image Settings → Pair RAW companions** persists false through the existing config storage and cache-invalidation paths; subsequent thumbnail jobs read that setting. Default-on and disabled behavior have regression coverage.
- The upstream main merge preserves JPEG XL decoding tiers, JPEG progression settings, video fallback, and OCR search text updates. The feature changes no schema or migrations relative to the pinned upstream baseline. Its generated API delta adds only the required `AdminConfigImageDto.rawCompanions` boolean in OpenAPI and the TypeScript SDK. The mobile compatibility patch supplies the missing value before generated Dart deserialization when talking to an older server.
- The main-only CI harness resolves the exact feature commit, verifies the minimal branch boundary, and validates generated files, server, web, and runtime behavior before publishing a unique image tag. Only the image-publishing job receives package-write permission. Browser evidence excludes transient credentials.

The [settings browser run](https://github.com/ajnart/immich-slop-fork/actions/runs/42331405731) exercised the real Image Settings switch and Save button against the published feature image. It checked the default enabled state, saved off, reloaded, and checked both the switch and `GET /api/admin/config`; it then saved on and repeated those checks. The [settings screenshot](assets/raw-companions/settings.png), [settings video](assets/raw-companions/settings.mp4), and [report](assets/raw-companions/report.json) preserve that evidence.

## Validation exclusions

The final unit suite retains two upstream cases: an expected failure for an invalid timeline time bucket (`timeline.controller.spec.ts`) and a skipped OAuth quota-default case (`auth.service.spec.ts`). The fork adds no skipped or expected-failure tests. Exact totals and runtime evidence are linked in the guide.

## Practical limits

The native apps' existing stack records and sync APIs are reused. Browser tests cover desktop and a phone-sized responsive viewport, not physical iOS/Android devices. The iOS uploader may select only one resource from a combined Apple Photos RAW/JPEG asset; both files must reach the server for pairing.

Unstacking is not a persistent pairing exclusion. Later thumbnail regeneration can pair compatible files again; disabling automatic pairing prevents this. RAW uploaded before its JPEG may initially be decoded. Independent thumbnails and both originals still occupy storage.

No additional production correctness/security blocker was identified in the reviewed fork delta after the refresh fix. See [the installation guide](SLOP-FORK.md#validation-and-review) for exact final CI and browser evidence. Upstream main includes migrations beyond v3.3.6, so a production downgrade after upgrading requires a matching database/media restore.
