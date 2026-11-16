import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';
import { memberUri } from '../features/fileSystems';
import { describeFilter, exactLibraries, filterLibrariesSql, filterShows, memberCondition, ObjectFilter, objectArgs, sourceFileCondition } from '../core/objectFilters';

/** Expanding the same library or source file again within this time reuses the list (Refresh reads it again). */
const TREE_CACHE_MS = 20_000;

export type LibNode =
  | { kind: 'filter'; filter: ObjectFilter }
  | { kind: 'library'; library: string; current: boolean; filter?: ObjectFilter; text?: string }
  | { kind: 'folder'; library: string; folder: 'source' | 'objects'; filter?: ObjectFilter }
  | { kind: 'srcfile'; library: string; file: string; text: string; filter?: ObjectFilter }
  | { kind: 'member'; library: string; file: string; member: string; type: string; text: string; changed?: string; created?: string; lines?: number }
  | { kind: 'object'; library: string; name: string; type: string; attribute: string; text: string }
  | { kind: 'message'; text: string; error?: boolean };

const OBJECT_ICONS: Record<string, string> = {
  '*PGM': 'gear', '*SRVPGM': 'package', '*MODULE': 'symbol-module', '*FILE': 'database',
  '*DTAARA': 'symbol-variable', '*DTAQ': 'list-ordered', '*CMD': 'terminal', '*MSGF': 'mail',
  '*JOBD': 'briefcase', '*OUTQ': 'output', '*BNDDIR': 'references', '*USRSPC': 'symbol-namespace',
};

export class LibraryTreeProvider implements vscode.TreeDataProvider<LibNode> {
  private readonly emitter = new vscode.EventEmitter<LibNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(node?: LibNode): void { this.emitter.fire(node); }

  getTreeItem(n: LibNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'filter': {
        const item = new vscode.TreeItem(n.filter.name, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon('filter');
        item.description = describeFilter(n.filter);
        item.tooltip = vscode.l10n.t('Object filter: {0}', describeFilter(n.filter));
        item.contextValue = 'filter';
        return item;
      }
      case 'library': {
        const item = new vscode.TreeItem(n.library, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.current ? 'star-full' : 'library');
        item.description = n.current ? 'current library' : n.text ?? '';
        item.contextValue = 'library';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(n.folder === 'source' ? 'Source files' : 'Objects', C.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.folder === 'source' ? 'folder-library' : 'symbol-structure');
        item.contextValue = `folder.${n.folder}`;
        return item;
      }
      case 'srcfile': {
        const item = new vscode.TreeItem(n.file, C.Collapsed);
        item.iconPath = new vscode.ThemeIcon('file-submodule');
        const days = this.memberFilter.get(`${n.library}/${n.file}`);
        item.description = (days ? `changed ≤ ${days}d · ` : '') + n.text;
        item.tooltip = `${n.library}/${n.file}${n.text ? ` — ${n.text}` : ''}`;
        item.contextValue = 'srcfile';
        return item;
      }
      case 'member': {
        const label = n.type ? `${n.member}.${n.type.toLowerCase()}` : n.member;
        const item = new vscode.TreeItem(label, C.None);
        item.iconPath = new vscode.ThemeIcon('file-code');
        const changed = n.changed ? n.changed.slice(0, 10) : '';
        item.description = [changed, n.text].filter(Boolean).join(' · ');
        item.resourceUri = memberUri(n.library, n.file, n.member, n.type);
        item.tooltip = new vscode.MarkdownString(
          `**${n.library}/${n.file}(${n.member})**  \nType: ${n.type || '—'}  \n${n.text || ''}` +
          (n.changed ? `  \nLast changed: ${n.changed.replace(/\.\d+$/, '')}` : '') +
          (n.created ? `  \nCreated: ${n.created.replace(/\.\d+$/, '')}` : '') +
          (n.lines !== undefined ? `  \nLines: ${n.lines}` : ''));
        item.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [item.resourceUri] };
        item.contextValue = 'member';
        return item;
      }
      case 'object': {
        const item = new vscode.TreeItem(n.name, C.None);
        item.iconPath = new vscode.ThemeIcon(OBJECT_ICONS[n.type] ?? 'symbol-misc');
        item.description = `${n.type}${n.attribute ? ` ${n.attribute}` : ''}${n.text ? ` — ${n.text}` : ''}`;
        item.tooltip = `${n.library}/${n.name} ${n.type} ${n.attribute}\n${n.text}\nClick for object information`;
        item.command = { command: 'vanthrex.objectInfo', title: vscode.l10n.t('Object information'), arguments: [{ library: n.library, name: n.name, type: n.type }] };
        item.contextValue = n.type === '*FILE' && /SAVF/i.test(n.attribute ?? '') ? 'object.savf' : n.type === '*PGM' ? 'object.pgm' : n.type === '*FILE' ? 'object.file' : n.type === '*SRVPGM' ? 'object.srvpgm'
          : n.type === '*DTAQ' ? 'object.dtaq' : n.type === '*DTAARA' ? 'object.dtaara' : n.type === '*MSGF' ? 'object.msgf' : n.type === '*BNDDIR' ? 'object.bnddir' : 'object';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(n.text, C.None);
        item.iconPath = new vscode.ThemeIcon(n.error ? 'error' : 'info');
        return item;
      }
    }
  }

  async getChildren(n?: LibNode): Promise<LibNode[]> {
    const conn = this.manager.connection;
    if (!conn) { return []; }
    try {
      if (!n) {
        const p = conn.profile;
        const libs = [...p.libraries];
        if (p.currentLibrary && !libs.includes(p.currentLibrary)) { libs.unshift(p.currentLibrary); }
        return [
          ...libs.map(library => ({ kind: 'library', library, current: library === p.currentLibrary }) as LibNode),
          ...(p.filters ?? []).map(filter => ({ kind: 'filter', filter }) as LibNode),
        ];
      }
      const showObjects = vscode.workspace.getConfiguration('vanthrex').get<boolean>('objects.showAll', true);
      switch (n.kind) {
        case 'filter':
          return this.filterLibraries(n.filter);
        case 'library': {
          const shows = n.filter ? filterShows(n.filter) : { source: true, objects: true };
          // A filter that names only object types shows those objects, even when the view hides objects otherwise.
          if (!shows.source) { return this.objects(n.library, n.filter); }
          if (!showObjects || !shows.objects) { return this.sourceFiles(n.library, n.filter); }
          return [{ kind: 'folder', library: n.library, folder: 'source', filter: n.filter }, { kind: 'folder', library: n.library, folder: 'objects', filter: n.filter }];
        }
        case 'folder':
          return n.folder === 'source' ? this.sourceFiles(n.library, n.filter) : this.objects(n.library, n.filter);
        case 'srcfile':
          return this.members(n.library, n.file, n.filter);
        default:
          return [];
      }
    } catch (e) {
      logError(e);
      return [{ kind: 'message', text: errorMessage(e).split('\n')[0], error: true }];
    }
  }

  /** The libraries an object filter picks: its exact names as they are, generic names read from the system. */
  private async filterLibraries(f: ObjectFilter): Promise<LibNode[]> {
    const exact = exactLibraries(f);
    if (exact) { return exact.map(library => ({ kind: 'library', library, current: false, filter: f })); }
    const rows = await this.manager.require().cachedRows<{ LIB: string; TEXT: string }>(filterLibrariesSql(f), 500, TREE_CACHE_MS);
    if (!rows.length) { return [{ kind: 'message', text: vscode.l10n.t('No library matches {0}', f.library) }]; }
    return rows.map(r => ({ kind: 'library', library: String(r.LIB).trim(), current: false, filter: f, text: String(r.TEXT ?? '').trim() }));
  }

  private async sourceFiles(library: string, filter?: ObjectFilter): Promise<LibNode[]> {
    const rows = await this.manager.require().cachedRows<{ NAME: string; TEXT: string }>(
      `SELECT SYSTEM_TABLE_NAME AS NAME, COALESCE(TABLE_TEXT, '') AS TEXT FROM QSYS2.SYSTABLES ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(library)} AND FILE_TYPE = 'S'${filter ? sourceFileCondition(filter) : ''} ORDER BY 1`, 5000, TREE_CACHE_MS);
    if (!rows.length) { return [{ kind: 'message', text: filter ? vscode.l10n.t('No source file matches the filter') : 'No source files (right-click the library to create one)' }]; }
    return rows.map(r => ({ kind: 'srcfile', library, file: String(r.NAME).trim(), text: String(r.TEXT ?? '').trim(), filter }));
  }

  /** Per source file ("LIB/FILE"): only show members changed in the last N days. */
  readonly memberFilter = new Map<string, number>();

  private async members(library: string, file: string, filter?: ObjectFilter): Promise<LibNode[]> {
    const byDate = vscode.workspace.getConfiguration('vanthrex').get<string>('members.sortBy', 'name') === 'date';
    const days = this.memberFilter.get(`${library}/${file}`);
    const rows = await this.manager.require().cachedRows<{ NAME: string; TYPE: string; TEXT: string; CHANGED: string; CREATED: string; N: number }>(
      `SELECT SYSTEM_TABLE_MEMBER AS NAME, COALESCE(SOURCE_TYPE, '') AS TYPE, COALESCE(PARTITION_TEXT, '') AS TEXT, ` +
      `VARCHAR(LAST_SOURCE_UPDATE_TIMESTAMP) AS CHANGED, VARCHAR(CREATE_TIMESTAMP) AS CREATED, NUMBER_ROWS AS N ` +
      `FROM QSYS2.SYSPARTITIONSTAT ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(library)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ` +
      (days ? `AND LAST_SOURCE_UPDATE_TIMESTAMP >= CURRENT TIMESTAMP - ${Math.floor(days)} DAYS ` : '') +
      (filter ? `${memberCondition(filter)} ` : '') +
      `ORDER BY ${byDate ? 'LAST_SOURCE_UPDATE_TIMESTAMP DESC, ' : ''}1`, 20000, TREE_CACHE_MS);
    if (!rows.length) {
      return [{ kind: 'message', text: days ? `No members changed in the last ${days} days` : filter && memberCondition(filter) ? vscode.l10n.t('No member matches the filter') : 'Empty source file (click + to add a member)' }];
    }
    return rows.map(r => ({
      kind: 'member', library, file,
      member: String(r.NAME).trim(), type: String(r.TYPE ?? '').trim(), text: String(r.TEXT ?? '').trim(),
      changed: r.CHANGED ? String(r.CHANGED) : undefined,
      created: r.CREATED ? String(r.CREATED) : undefined,
      lines: r.N === null || r.N === undefined ? undefined : Number(r.N),
    }));
  }

  private async objects(library: string, filter?: ObjectFilter): Promise<LibNode[]> {
    const a = filter ? objectArgs(filter) : { types: '*ALL', where: '' };
    const rows = await this.manager.require().cachedRows<{ OBJNAME: string; OBJTYPE: string; ATTR: string; TEXT: string }>(
      `SELECT OBJNAME, OBJTYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, COALESCE(OBJTEXT, '') AS TEXT ` +
      `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(library)}, ${sqlString(a.types)})) X${a.where} ORDER BY OBJTYPE, OBJNAME`, 20000, TREE_CACHE_MS);
    if (!rows.length) { return [{ kind: 'message', text: filter ? vscode.l10n.t('No object matches the filter') : 'No objects' }]; }
    return rows.map(r => ({
      kind: 'object', library,
      name: String(r.OBJNAME).trim(), type: String(r.OBJTYPE).trim(),
      attribute: String(r.ATTR ?? '').trim(), text: String(r.TEXT ?? '').trim(),
    }));
  }
}
