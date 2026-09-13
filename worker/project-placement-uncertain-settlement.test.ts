// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPage } from '../src/pages/ProjectPage';
import { ProjectApiError, projectApi } from '../src/lib/project-client';
import { createProject, createMarkdownProjectItem, readProjectSnapshot, updateProjectPlacement } from '../worker/projects/service';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { projectTestSnapshot } from '../src/project-test-fixture';
import type { ProjectGeometryCommand, ProjectNodeDescriptor } from '../src/lib/project-map-model';
import type { ProjectEdgeConnection } from '../src/lib/project-edge-history';

vi.mock('../src/components/ReferenceSearchSurface', () => ({ ReferenceSearchSurface: () => null }));
vi.mock('../src/components/project/ProjectMapSurface', () => ({
  ProjectMapSurface: ({ nodes, onGeometryCommit, onGeometryBatchCommit, onEdgeConnect }: {
    nodes: ProjectNodeDescriptor[];
    onGeometryCommit: (command: ProjectGeometryCommand) => void;
    onGeometryBatchCommit: (commands: ProjectGeometryCommand[]) => void;
    onEdgeConnect: (connection: ProjectEdgeConnection) => void;
  }) => createElement(Fragment, null,
    createElement('button', {onClick:() => {
      const node = nodes[0];
      onGeometryCommit({ placementId:node.placementId, before:node.geometry, after:{ ...node.geometry, x:80 } });
    }}, 'Move card'),
    createElement('button', {onClick:() => onGeometryBatchCommit(nodes.map(node => ({
      placementId:node.placementId, before:node.geometry, after:{ ...node.geometry, x:node.geometry.x + 80 },
    })))}, 'Move all cards'),
    createElement('button', {onClick:() => onEdgeConnect({
      sourceItemId:nodes[0].itemId, targetItemId:nodes[1].itemId, sourceHandle:'right', targetHandle:'left',
    })}, 'Connect cards'),
  ),
}));

function testDatabase() {
  const database = new DatabaseSync(':memory:');
  const directory = `${process.cwd()}/migrations`;
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(`${directory}/${file}`, 'utf8'));
  }
  function statement(sql: string, values: unknown[] = []) {
    const execute = () => {
      const prepared = database.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results:prepared.all(...values as []), success:true, meta:{changes:0} };
      return { results:[], success:true, meta:{changes:Number(prepared.run(...values as []).changes)} };
    };
    return {
      bind:(...bindings: unknown[]) => statement(sql, bindings),
      execute, run:async () => execute(), all:async () => execute(),
      first:async () => database.prepare(sql).get(...values as []) ?? null,
    };
  }
  const db = {
    prepare:statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      database.exec('BEGIN');
      try { const results=statements.map(statement => statement.execute()); database.exec('COMMIT'); return results; }
      catch(error) { database.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  return { database, db };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains the exact placement request through uncertain retries until its late commit is acknowledged', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:true, media:'(min-width: 860px)', addEventListener:vi.fn(), removeEventListener:vi.fn(), addListener:vi.fn(), removeListener:vi.fn()})));
  const { database, db } = testDatabase();
  const projectId = 'audit-project';
  const actor = 'synthetic-audit@example.com';
  const now = '2026-09-13T03:00:00.000Z';
  await createProject(db, { id:projectId, title:'Synthetic audit', operationId:'project-create' }, actor, now);
  await createMarkdownProjectItem(db, projectId, {
    itemId:'item-a', contentId:'content-a', placementId:'placement-a', markdownSource:'Synthetic card',
    geometry:{x:0,y:0,width:320,height:180,zIndex:0}, expectedProjectRevision:1, operationId:'item-create',
  }, actor, now);
  vi.spyOn(projectApi, 'read').mockImplementation((id) => readProjectSnapshot(db, id));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const heldDb = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!/^\s*UPDATE project_map_placements/.test(sql)) return statement;
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { async run() { entered(); await gate; return bound.run(); } };
      }};
    },
  } as D1Database;
  let originalWrite!: ReturnType<typeof updateProjectPlacement>;
  const update = vi.spyOn(projectApi, 'updatePlacement').mockImplementationOnce(async (id, placement, input) => {
    originalWrite = updateProjectPlacement(heldDb, id, placement, input, actor, now);
    await enteredGate;
    throw new TypeError('Connection closed before acknowledgment');
  })
    .mockRejectedValueOnce(new ProjectApiError('Access denied', 403))
    .mockRejectedValueOnce(new ProjectApiError('Temporary Project lifecycle conflict', 409))
    .mockImplementation((id, placement, input) => updateProjectPlacement(db, id, placement, input, actor, now));
  const router = createMemoryRouter([
    { path:'/projects/:projectId', element:createElement(ProjectPage) },
    { path:'/projects', element:createElement('p', null, 'Projects route') },
  ], {initialEntries:[`/projects/${projectId}`]});
  render(createElement(RouterProvider, {router}));
  fireEvent.click(await screen.findByRole('button', { name:'Move card' }));
  fireEvent.click(screen.getByRole('button', { name:'Save' }));
  await screen.findByText('Connection closed before acknowledgment');
  expect(database.prepare('SELECT x, revision FROM project_map_placements').get()).toEqual({x:0, revision:1});
  fireEvent.click(screen.getByRole('link', { name:'Projects' }));
  await screen.findByRole('alertdialog', { name:'Unsaved Project changes' });
  const frozen = update.mock.calls[0][2];
  for (const message of ['Access denied', 'Temporary Project lifecycle conflict']) {
    expect(screen.queryByRole('button', { name:'Leave without saving' })).toBeNull();
    expect(screen.queryByRole('button', { name:'Reload authoritative Project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name:'Retry save and leave' }));
    await screen.findByText(message);
    expect(update.mock.calls.at(-1)![2]).toEqual(frozen);
  }
  expect(screen.queryByRole('button', { name:'Leave without saving' })).toBeNull();
  expect(screen.queryByRole('button', { name:'Reload authoritative Project' })).toBeNull();
  expect(screen.queryByText('Projects route')).toBeNull();
  release();
  const committed = await originalWrite;
  expect(committed.value).toMatchObject({ x:80, revision:2 });
  fireEvent.click(screen.getByRole('button', { name:'Retry save and leave' }));
  await screen.findByText('Projects route');
  expect(update).toHaveBeenCalledTimes(4);
  expect(update.mock.calls.every((call) => JSON.stringify(call[2]) === JSON.stringify(frozen))).toBe(true);
  expect(database.prepare('SELECT x, revision FROM project_map_placements').get()).toEqual({x:80, revision:2});
  database.close();
});

it('allows reload after a backend settlement proof fences off the uncertain placement request', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:true, media:'(min-width: 860px)', addEventListener:vi.fn(), removeEventListener:vi.fn(), addListener:vi.fn(), removeListener:vi.fn()})));
  const initial = projectTestSnapshot();
  const read = vi.spyOn(projectApi, 'read').mockResolvedValue(initial);
  const update = vi.spyOn(projectApi, 'updatePlacement')
    .mockRejectedValueOnce(new TypeError('Acknowledgment lost'))
    .mockRejectedValueOnce(new ProjectApiError('Placement revision conflict', 409, 'authoritative-rejection'));
  const router = createMemoryRouter([{ path:'/projects/:projectId', element:createElement(ProjectPage) }], {
    initialEntries:['/projects/project-a'],
  });
  render(createElement(RouterProvider, {router}));
  fireEvent.click(await screen.findByRole('button', { name:'Move card' }));
  fireEvent.click(screen.getByRole('button', { name:'Save' }));
  await screen.findByText('Acknowledgment lost');
  expect(screen.queryByRole('button', { name:'Reload authoritative Project' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name:'Retry save' }));
  const reload = await screen.findByRole('button', { name:'Reload authoritative Project' });
  expect(update.mock.calls[1][2]).toEqual(update.mock.calls[0][2]);
  const advanced = structuredClone(initial);
  const changed = advanced.placements.find(placement => placement.id === update.mock.calls[0][1])!;
  changed.revision = 2;
  changed.x = 140;
  read.mockResolvedValue(advanced);
  fireEvent.click(reload);
  await screen.findByText('Saved');
  expect(read).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledTimes(2);
});

it('retries only the unacknowledged placement in a group save and waits for the final ACK', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:true, media:'(min-width: 860px)', addEventListener:vi.fn(), removeEventListener:vi.fn(), addListener:vi.fn(), removeListener:vi.fn()})));
  const initial = projectTestSnapshot();
  vi.spyOn(projectApi, 'read').mockResolvedValue(initial);
  let acknowledge!: () => void;
  const finalAck = new Promise<void>(resolve => { acknowledge = resolve; });
  let attempts = 0;
  const update = vi.spyOn(projectApi, 'updatePlacement').mockImplementation(async (_id, placementId, input) => {
    attempts++;
    if (attempts === 2) throw new TypeError('Second placement acknowledgment lost');
    if (attempts === 3) await finalAck;
    return { value:{ ...initial.placements.find(placement => placement.id === placementId)!, ...input.geometry, revision:2 }, replayed:attempts === 3 };
  });
  const router = createMemoryRouter([
    { path:'/projects/:projectId', element:createElement(ProjectPage) },
    { path:'/projects', element:createElement('p', null, 'Projects route') },
  ], {initialEntries:['/projects/project-a']});
  render(createElement(RouterProvider, {router}));
  fireEvent.click(await screen.findByRole('button', { name:'Move all cards' }));
  fireEvent.click(screen.getByRole('link', { name:'Projects' }));
  await screen.findByText('Second placement acknowledgment lost');
  expect(update).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name:'Leave without saving' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name:'Retry save and leave' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
  expect(update.mock.calls[2]).toEqual(update.mock.calls[1]);
  expect(update.mock.calls[0][1]).not.toBe(update.mock.calls[2][1]);
  expect(screen.queryByText('Projects route')).toBeNull();
  acknowledge();
  await screen.findByText('Projects route');
  expect(update).toHaveBeenCalledTimes(3);
});

it('settles placement saves before an overlapping edge conflict can reload the Project', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:true, media:'(min-width: 860px)', addEventListener:vi.fn(), removeEventListener:vi.fn(), addListener:vi.fn(), removeListener:vi.fn()})));
  const initial = projectTestSnapshot();
  const read = vi.spyOn(projectApi, 'read').mockResolvedValue(initial);
  let rejectPlacement!: (error: Error) => void;
  const firstAttempt = new Promise<never>((_resolve, reject) => { rejectPlacement = reject; });
  const update = vi.spyOn(projectApi, 'updatePlacement')
    .mockImplementationOnce(() => firstAttempt)
    .mockImplementation(async (_id, placementId, input) => ({
      value:{ ...initial.placements.find(placement => placement.id === placementId)!, ...input.geometry, revision:2 }, replayed:true,
    }));
  vi.spyOn(projectApi, 'createEdge').mockRejectedValue(new ProjectApiError('Edge identity conflict', 409, 'authoritative-rejection'));
  const router = createMemoryRouter([{ path:'/projects/:projectId', element:createElement(ProjectPage) }], {
    initialEntries:['/projects/project-a'],
  });
  render(createElement(RouterProvider, {router}));
  fireEvent.click(await screen.findByRole('button', { name:'Move card' }));
  fireEvent.click(screen.getByRole('button', { name:'Save' }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name:'Connect cards' }));
  await screen.findByText('Edge identity conflict');
  expect(screen.getByRole('button', { name:'Reload authoritative Project' }).hasAttribute('disabled')).toBe(true);
  rejectPlacement(new TypeError('Placement acknowledgment lost'));
  await screen.findByText('Placement acknowledgment lost');
  expect(screen.getByRole('button', { name:'Reload authoritative Project' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name:'Retry save' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name:'Retry save' }));
  await waitFor(() => expect(screen.getByRole('button', { name:'Reload authoritative Project' }).hasAttribute('disabled')).toBe(false));
  expect(update.mock.calls[1]).toEqual(update.mock.calls[0]);
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name:'Reload authoritative Project' }));
  await screen.findByText('Saved');
  expect(read).toHaveBeenCalledTimes(2);
});
