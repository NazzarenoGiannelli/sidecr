export interface PendingItem {
  file: File;
  /** Preview object URL, created once when the file is added; null for non-images. */
  url: string | null;
}

/** The attachment list. Object URLs are created on add and revoked on remove/clear, each exactly once. */
export function createPending(createUrl: (f: File) => string, revokeUrl: (url: string) => void) {
  let list: PendingItem[] = [];
  return {
    get items(): readonly PendingItem[] {
      return list;
    },
    get count(): number {
      return list.length;
    },
    files(): File[] {
      return list.map((i) => i.file);
    },
    add(files: Iterable<File>): void {
      for (const file of files) {
        list.push({ file, url: file.type.startsWith("image/") ? createUrl(file) : null });
      }
    },
    remove(index: number): void {
      const [gone] = list.splice(index, 1);
      if (gone?.url) revokeUrl(gone.url);
    },
    clear(): void {
      for (const i of list) if (i.url) revokeUrl(i.url);
      list = [];
    },
  };
}
