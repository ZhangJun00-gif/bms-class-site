import { knowledgeImportInternals } from './knowledge-import';

function fixture() {
  const state = {
    photo: true,
    original: true,
    operations: [] as unknown[],
  };
  const photo = {
    objectKey: 'media/test-display.webp', size: 12, albumId: null as string | null,
    original: { objectKey: 'media/test-original.png' } as { objectKey: string } | null,
    news: [] as Array<{ newsId: string }>,
    quizQuestions: [] as Array<{ questionId: string }>,
    knowledgeImages: [{ documentVersionId: 'version-1' }],
    knowledgeImportAssets: [{ id: 'asset-1', importId: 'import-1' }],
  };
  const order: string[] = [];
  const transaction = {
    $queryRaw: jest.fn(async () => { order.push('lock-photo'); return [{ id: 'photo-1' }]; }),
    photo: {
      findUnique: jest.fn(async () => state.photo ? photo : null),
      deleteMany: jest.fn(async () => {
        order.push('delete-photo');
        state.photo = false;
        return { count: 1 };
      }),
    },
    photoOriginal: {
      deleteMany: jest.fn(async () => {
        order.push('delete-original');
        state.original = false;
        return { count: 1 };
      }),
    },
    mediaObjectOperation: {
      create: jest.fn(async (args: { data: unknown }) => {
        order.push('persist-manifest');
        state.operations.push(args.data);
        return {};
      }),
    },
    knowledgeVersionImage: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    knowledgeImportAsset: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const remove = async (versions = ['version-1'], importId?: string) => {
    const snapshot = structuredClone(state);
    try {
      return await knowledgeImportInternals.deleteUnusedKnowledgePhoto(transaction as never, 'photo-1', versions, importId);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  };
  return { state, photo, transaction, remove, order };
}

describe('knowledge photo cleanup with originals', () => {
  it('persists both exact keys before deleting the original and photo under one lock', async () => {
    const test = fixture();
    await test.remove();
    expect(test.order).toEqual(['lock-photo', 'persist-manifest', 'delete-original', 'delete-photo']);
    expect(test.state.operations).toEqual([expect.objectContaining({
      kind: 'PHOTO_DELETE', status: 'CLEANUP_PENDING', photoId: 'photo-1',
      manifest: [
        { key: 'media/test-display.webp', status: 'PENDING' },
        { key: 'media/test-original.png', status: 'PENDING' },
      ],
    })]);
    expect(test.state).toMatchObject({ photo: false, original: false });
    await test.remove();
    expect(test.transaction.mediaObjectOperation.create).toHaveBeenCalledTimes(1);
  });

  it.each(['album', 'news', 'quiz', 'other-version', 'other-import'])('preserves a photo and its original still referenced by %s', async (reference) => {
    const test = fixture();
    if (reference === 'album') test.photo.albumId = 'album-1';
    if (reference === 'news') test.photo.news = [{ newsId: 'news-1' }];
    if (reference === 'quiz') test.photo.quizQuestions = [{ questionId: 'question-1' }];
    if (reference === 'other-version') test.photo.knowledgeImages.push({ documentVersionId: 'other-version' });
    if (reference === 'other-import') test.photo.knowledgeImportAssets[0]!.importId = 'other-import';
    expect(await test.remove(['version-1'], 'import-1')).toBeNull();
    expect(test.state).toEqual({ photo: true, original: true, operations: [] });
    expect(test.transaction.photoOriginal.deleteMany).not.toHaveBeenCalled();
    expect(test.transaction.knowledgeVersionImage.deleteMany).not.toHaveBeenCalled();
  });

  it('rolls back original removal and the pending manifest when the final photo CAS fails', async () => {
    const test = fixture();
    test.transaction.photo.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(test.remove()).rejects.toThrow('PHOTO_DELETE_CONFLICT');
    expect(test.transaction.photoOriginal.deleteMany).toHaveBeenCalledTimes(1);
    expect(test.state).toEqual({ photo: true, original: true, operations: [] });
  });

  it('supports old photos without original rows and omits absent keys from the manifest', async () => {
    const test = fixture();
    test.photo.original = null;
    test.state.original = false;
    await test.remove();
    expect(test.state.operations).toEqual([expect.objectContaining({
      manifest: [{ key: 'media/test-display.webp', status: 'PENDING' }],
    })]);
  });
});
