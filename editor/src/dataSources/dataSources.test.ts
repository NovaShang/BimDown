import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createFileSystemDataSource } from './fileSystem.ts';
import { createMemoryDataSource } from './memory.ts';
import { loadProjectFromZip } from './zip.ts';
import { changedTableName } from '../hooks/useLiveProject.ts';

/** Minimal in-memory stand-in for a File System Access directory handle. */
class FakeDir {
  kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  name: string;
  constructor(name: string) { this.name = name; }
  async *values() { yield* this.children.values(); }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.children.get(name);
    if (!d && opts?.create) { d = new FakeDir(name); this.children.set(name, d); }
    if (!(d instanceof FakeDir)) throw new DOMException('not found', 'NotFoundError');
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.children.get(name);
    if (!f && opts?.create) { f = new FakeFile(name, ''); this.children.set(name, f); }
    if (!(f instanceof FakeFile)) throw new DOMException('not found', 'NotFoundError');
    return f;
  }
}

class FakeFile {
  kind = 'file' as const;
  mtime = 1;
  name: string;
  content: string;
  constructor(name: string, content: string) { this.name = name; this.content = content; }
  async getFile() {
    const { content, mtime } = this;
    return { lastModified: mtime, text: async () => content };
  }
  async createWritable() {
    let buf = '';
    return {
      write: async (s: string) => { buf += s; },
      close: async () => { this.content = buf; this.mtime++; },
    };
  }
}

function fakeFolder(files: Record<string, string>): FakeDir {
  const root = new FakeDir('root');
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (!dir.children.has(p)) dir.children.set(p, new FakeDir(p));
      dir = dir.children.get(p) as FakeDir;
    }
    dir.children.set(parts.at(-1)!, new FakeFile(parts.at(-1)!, content));
  }
  return root;
}

const asHandle = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

describe('createFileSystemDataSource', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads, writes and lists project files, skipping dot-folders', async () => {
    const root = fakeFolder({
      'global/level.csv': 'id\nlv-1',
      '.git/HEAD': 'ref',
      'node_modules/x/index.js': '',
    });
    const ds = createFileSystemDataSource(asHandle(root));
    expect(await ds.fetchText('global/level.csv')).toBe('id\nlv-1');
    expect(await ds.fetchText('lv-1/wall.csv')).toBeNull();
    await ds.saveFile('lv-1/wall.csv', 'id\nw-1');
    expect(await ds.fetchText('lv-1/wall.csv')).toBe('id\nw-1');
    expect((await ds.listFiles!()).sort()).toEqual(['global/level.csv', 'lv-1/wall.csv']);
  });

  it('reports external changes on poll, but not its own writes', async () => {
    vi.useFakeTimers();
    const root = fakeFolder({ 'lv-1/wall.csv': 'a', 'lv-1/door.csv': 'b' });
    const ds = createFileSystemDataSource(asHandle(root));
    const changed: string[] = [];
    const stop = ds.watchChanges(p => changed.push(p));
    await vi.advanceTimersByTimeAsync(0); // initial snapshot

    await ds.saveFile('lv-1/wall.csv', 'mine');
    const door = (root.children.get('lv-1') as FakeDir).children.get('door.csv') as FakeFile;
    door.content = 'agent edit';
    door.mtime++;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(changed).toEqual(['lv-1/door.csv']);

    // an external write right after our own write to the same file still counts
    await ds.saveFile('lv-1/wall.csv', 'mine again');
    const wall = (root.children.get('lv-1') as FakeDir).children.get('wall.csv') as FakeFile;
    wall.content = 'agent edit';
    wall.mtime++;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changed).toEqual(['lv-1/door.csv', 'lv-1/wall.csv']);
    stop();
  });
});

describe('zip + memory sources', () => {
  it('unzips text and binary files and strips a single root folder', async () => {
    const zip = new JSZip();
    zip.file('proj/global/level.csv', 'id\nlv-1');
    zip.file('proj/lv-1/mesh.glb', new Uint8Array([0, 159, 146, 150]));
    zip.file('__MACOSX/proj/._level.csv', 'junk');
    const blob = await zip.generateAsync({ type: 'blob' });

    const files = await loadProjectFromZip(blob);
    expect([...files.keys()].sort()).toEqual(['global/level.csv', 'lv-1/mesh.glb']);
    expect(files.get('global/level.csv')).toBe('id\nlv-1');
    expect(new Uint8Array(files.get('lv-1/mesh.glb') as ArrayBuffer)).toEqual(new Uint8Array([0, 159, 146, 150]));

    const mem = createMemoryDataSource(files);
    expect((await mem.dataSource.listFiles!()).sort()).toEqual(['global/level.csv', 'lv-1/mesh.glb']);
    await mem.dataSource.saveFile('lv-1/wall.csv', 'id');
    expect(mem.getFiles().get('lv-1/wall.csv')).toBe('id');
    // the source map is a copy: the caller's map is untouched
    expect(files.has('lv-1/wall.csv')).toBe(false);
  });
});

describe('changedTableName', () => {
  it('maps csv and geojson files to their table', () => {
    expect(changedTableName('wall.csv')).toBe('wall');
    expect(changedTableName('wall.geojson')).toBe('wall');
    expect(changedTableName('wall.svg')).toBe('');
  });
});
