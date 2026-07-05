import { describe, it, expect } from 'vitest';
import {
  copyProductToWorkspace,
  moveProductToWorkspace,
  checkProductMove,
  copyDesignToWorkspace,
  moveDesignToWorkspace,
  checkDesignMove,
  transferTools,
} from '../src/tools/transfer.js';
import { fakeContext } from './helpers/ctx.js';
import { apiReturning, apiRecording } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids, no real account
// data. p1/d1 = source asset ids; w-src / w-dest = workspace uuids; "Acme Co" name.

describe('copy_product_to_workspace', () => {
  it('POSTs to product/<id>/copy with workspace_uuid in the body, and source_workspace as ?workspace=', async () => {
    const { api, calls } = apiRecording({
      message: 'Product copied',
      product: { uuid: 'p2', name: 'Acme Tee', status: 'draft' },
    });
    const res = (await copyProductToWorkspace.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest', source_workspace: 'w-src' },
      fakeContext(api),
    )) as any;

    const call = calls[0]!;
    expect(call.init?.method).toBe('POST');
    expect(call.url).toContain('/product/p1/copy');
    // Source scope rides ?workspace= (workspace_scope_mode=enforce).
    expect(call.url).toContain('workspace=w-src');

    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({ workspace_uuid: 'w-dest' });

    // Surfaces the NEW uuid + a view_url, echoes the destination.
    expect(res).toMatchObject({
      new_product_uuid: 'p2',
      source_product_uuid: 'p1',
      destination_workspace: 'w-dest',
      view_url: 'https://apparelhub.ai/merchandise/my-products/p2',
    });
  });

  it('omits ?workspace= when source_workspace is not given (Default workspace)', async () => {
    const { api, calls } = apiRecording({ product: { uuid: 'p2' } });
    await copyProductToWorkspace.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest' },
      fakeContext(api),
    );
    expect(calls[0]!.url).not.toContain('workspace=');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ workspace_uuid: 'w-dest' });
  });

  it('tolerates a bare (un-enveloped) product payload', async () => {
    const res = (await copyProductToWorkspace.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest' },
      fakeContext(apiReturning({ uuid: 'p3' })),
    )) as any;
    expect(res.new_product_uuid).toBe('p3');
  });
});

describe('move_product_to_workspace', () => {
  it('POSTs to product/<id>/move with workspace_uuid body and marks the move applied', async () => {
    const { api, calls } = apiRecording({ message: 'Product moved', product: { uuid: 'p1' } });
    const res = (await moveProductToWorkspace.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest', source_workspace: 'w-src' },
      fakeContext(api),
    )) as any;

    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.url).toContain('/product/p1/move');
    expect(calls[0]!.url).toContain('workspace=w-src');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ workspace_uuid: 'w-dest' });
    expect(res).toMatchObject({ product_uuid: 'p1', moved: true, destination_workspace: 'w-dest' });
  });

  it('is annotated open-world but NOT destructive (move re-stamps, does not destroy the source)', () => {
    expect(moveProductToWorkspace.annotations).toEqual({ openWorldHint: true });
    expect(moveProductToWorkspace.annotations?.destructiveHint).toBeUndefined();
  });
});

describe('check_product_move', () => {
  it('GETs move-eligibility with destination as ?workspace_uuid= and source as ?workspace=', async () => {
    const { api, calls } = apiRecording({ eligible: true, blockers: [] });
    const res = (await checkProductMove.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest', source_workspace: 'w-src' },
      fakeContext(api),
    )) as any;

    const url = calls[0]!.url;
    expect(calls[0]!.init?.method).toBe('GET');
    expect(url).toContain('/product/p1/move-eligibility');
    expect(url).toContain('workspace_uuid=w-dest'); // destination is a query param on eligibility
    expect(url).toContain('workspace=w-src'); // source scope
    expect(res).toEqual({ eligible: true, blockers: [] });
  });

  it('maps {eligible:false, blockers:[...]} and normalizes blocker reasons', async () => {
    const res = (await checkProductMove.handler(
      { product_uuid: 'p1', destination_workspace: 'w-dest' },
      fakeContext(
        apiReturning({
          eligible: false,
          blockers: [{ reason: 'asset_in_use', store_uuid: 's1', store_name: 'Acme Store' }],
        }),
      ),
    )) as any;
    expect(res.eligible).toBe(false);
    expect(res.blockers).toEqual([
      { reason: 'asset_in_use', store_uuid: 's1', store_name: 'Acme Store' },
    ]);
  });

  it('is read-only', () => {
    expect(checkProductMove.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});

describe('design copy/move/eligibility', () => {
  it('copy_design POSTs to images/generated/<id>/copy with workspace_uuid body + source scope', async () => {
    const { api, calls } = apiRecording({ message: 'Image copied', image: { uuid: 'd2' } });
    const res = (await copyDesignToWorkspace.handler(
      { design_uuid: 'd1', destination_workspace: 'w-dest', source_workspace: 'w-src' },
      fakeContext(api),
    )) as any;

    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.url).toContain('/images/generated/d1/copy');
    expect(calls[0]!.url).toContain('workspace=w-src');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ workspace_uuid: 'w-dest' });
    expect(res).toMatchObject({
      new_design_uuid: 'd2',
      source_design_uuid: 'd1',
      destination_workspace: 'w-dest',
      view_url: 'https://apparelhub.ai/images',
    });
  });

  it('move_design POSTs to images/generated/<id>/move', async () => {
    const { api, calls } = apiRecording({ message: 'Image moved', image: { uuid: 'd1' } });
    const res = (await moveDesignToWorkspace.handler(
      { design_uuid: 'd1', destination_workspace: 'w-dest' },
      fakeContext(api),
    )) as any;
    expect(calls[0]!.url).toContain('/images/generated/d1/move');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ workspace_uuid: 'w-dest' });
    expect(res).toMatchObject({ design_uuid: 'd1', moved: true });
  });

  it('check_design_move GETs move-eligibility mapping {eligible, blockers}', async () => {
    const { api, calls } = apiRecording({ eligible: true, blockers: [] });
    const res = (await checkDesignMove.handler(
      { design_uuid: 'd1', destination_workspace: 'w-dest', source_workspace: 'w-src' },
      fakeContext(api),
    )) as any;
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.url).toContain('/images/generated/d1/move-eligibility');
    expect(calls[0]!.url).toContain('workspace_uuid=w-dest');
    expect(calls[0]!.url).toContain('workspace=w-src');
    expect(res).toEqual({ eligible: true, blockers: [] });
  });
});

describe('transferTools export', () => {
  it('exports all six tools with unique, expected names', () => {
    const names = transferTools.map((t) => t.name);
    expect(names).toEqual([
      'copy_product_to_workspace',
      'move_product_to_workspace',
      'check_product_move',
      'copy_design_to_workspace',
      'move_design_to_workspace',
      'check_design_move',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
